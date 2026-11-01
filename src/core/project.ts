import { promises as fs } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { formatCode, migrateComponent } from './generate.js';
import { printNode, rewriteNode, typedParams } from './rewrite.js';
import type { MigrationOutput, MigrationWarning } from './types.js';
import { analyzeViewModel } from './vm.js';
import type { AiProvider } from './ai.js';
import { pascalCase } from './util.js';

export interface ProjectResult {
  components: { source: string; output: string; warnings: MigrationWarning[]; usedAi: boolean }[];
  valueConverters: string[];
  skipped: { file: string; reason: string }[];
  reportPath: string;
}

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'test', 'tests', '__tests__', 'coverage']);

async function walk(dir: string, acc: string[] = []): Promise<string[]> {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) await walk(path.join(dir, e.name), acc);
    } else acc.push(path.join(dir, e.name));
  }
  return acc;
}

const SERVICES_TSX = `import { createContext, useContext, type ReactNode } from 'react';

/** Replacement for Aurelia dependency injection. Register instances by class or string token. */
const ServiceContext = createContext<Map<unknown, unknown>>(new Map());

export function ServiceProvider({ services, children }: { services: [unknown, unknown][]; children: ReactNode }) {
  return <ServiceContext.Provider value={new Map(services)}>{children}</ServiceContext.Provider>;
}

export function useService<T>(token: unknown): T {
  const services = useContext(ServiceContext);
  if (!services.has(token)) {
    throw new Error(\`Service not registered: \${typeof token === 'function' ? token.name : String(token)}\`);
  }
  return services.get(token) as T;
}
`;

async function convertValueConverter(code: string, language: 'ts' | 'js', warnings: MigrationWarning[]): Promise<{ name: string; fn: string } | null> {
  const vm = analyzeViewModel(code, language);
  if (!vm?.isValueConverter || !vm.valueConverterName) return null;
  const toView = vm.members.find((m) => m.name === 'toView');
  if (!toView?.fn || !toView.fn.body) {
    warnings.push({ severity: 'warning', message: `${vm.className} has no toView method; skipped.` });
    return null;
  }
  const sf = vm.sourceFile;
  const members = new Set(vm.members.map((m) => m.name));
  const block = rewriteNode(toView.fn.body as ts.Node, { members, refs: new Set(), warnings, sf });
  const params = typedParams(toView.fn, sf);
  const text = ts.isBlock(block) ? printNode(block, sf) : `{ return ${printNode(block, sf)}; }`;
  if (vm.members.some((m) => m.name === 'fromView')) {
    warnings.push({ severity: 'info', message: `${vm.className}.fromView was not migrated (two-way conversion).` });
  }
  return { name: vm.valueConverterName, fn: `export function ${vm.valueConverterName}(${params}) ${text}` };
}

export async function migrateProject(
  srcDir: string,
  outDir: string,
  opts: { ai?: AiProvider } = {},
): Promise<ProjectResult> {
  const files = (await walk(srcDir)).filter((f) => !f.endsWith('.d.ts') && !/\.(spec|test)\.[jt]s$/.test(f));
  const byBase = new Map<string, { html?: string; ts?: string; js?: string }>();
  for (const f of files) {
    const ext = path.extname(f);
    if (!['.html', '.ts', '.js'].includes(ext)) continue;
    const base = f.slice(0, -ext.length);
    const entry = byBase.get(base) ?? {};
    entry[ext.slice(1) as 'html' | 'ts' | 'js'] = f;
    byBase.set(base, entry);
  }

  // Resolve tag -> import path per directory: Aurelia resolves <require> relative to the file,
  // so we pass a per-component map built from the component's own <require> elements.
  const result: ProjectResult = { components: [], valueConverters: [], skipped: [], reportPath: path.join(outDir, 'MIGRATION_REPORT.md') };
  await fs.mkdir(outDir, { recursive: true });

  const converters: { name: string; fn: string }[] = [];
  let usesServices = false;
  const converterWarnings: MigrationWarning[] = [];

  for (const [base, entry] of [...byBase.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const codeFile = entry.ts ?? entry.js;
    const language = entry.ts ? 'ts' : 'js';
    const rel = path.relative(srcDir, base);

    if (!entry.html) {
      if (codeFile && /-value-converter$/.test(base) || (codeFile && /ValueConverter/.test(await fs.readFile(codeFile, 'utf8')))) {
        const conv = await convertValueConverter(await fs.readFile(codeFile!, 'utf8'), language, converterWarnings);
        if (conv) { converters.push(conv); result.valueConverters.push(path.relative(srcDir, codeFile!)); continue; }
      }
      if (codeFile) result.skipped.push({ file: path.relative(srcDir, codeFile), reason: 'No matching view (.html); copy or port manually (services, models, config).' });
      continue;
    }

    const html = await fs.readFile(entry.html, 'utf8');
    const code = codeFile ? await fs.readFile(codeFile, 'utf8') : undefined;
    const depth = rel.split(path.sep).length - 1;
    const rootRelative = depth === 0 ? '.' : Array(depth).fill('..').join('/');
    const out: MigrationOutput = await migrateComponent(
      { name: path.basename(base), html, code, language },
      { rootRelative, ai: opts.ai },
    );
    if (code && /useService/.test(out.tsx)) usesServices = true;
    const outFile = path.join(outDir, path.dirname(rel), out.fileName);
    await fs.mkdir(path.dirname(outFile), { recursive: true });
    await fs.writeFile(outFile, out.tsx);
    result.components.push({ source: path.relative(srcDir, entry.html), output: path.relative(outDir, outFile), warnings: out.warnings, usedAi: out.usedAi });
  }

  if (usesServices) await fs.writeFile(path.join(outDir, 'services.tsx'), SERVICES_TSX);
  if (converters.length) {
    const body = converters.map((c) => c.fn).join('\n\n') +
      `\n\nexport const valueConverters = { ${converters.map((c) => c.name).join(', ')} };\n`;
    await fs.writeFile(path.join(outDir, 'valueConverters.ts'), await formatCode(body).catch(() => body));
  }

  await fs.writeFile(result.reportPath, renderReport(result, converterWarnings));
  return result;
}

export function renderReport(r: ProjectResult, extra: MigrationWarning[] = []): string {
  const lines: string[] = ['# Migration report', ''];
  const total = r.components.reduce((n, c) => n + c.warnings.filter((w) => w.severity !== 'info').length, 0);
  lines.push(`- Components migrated: **${r.components.length}**`, `- Value converters ported: **${r.valueConverters.length}**`, `- Items needing review: **${total}**`, `- Files skipped: **${r.skipped.length}**`, '');
  lines.push('> Generated code is a starting point. Review every item below and run your tests.', '');
  for (const c of r.components) {
    lines.push(`## ${c.output}`, `Source: \`${c.source}\`${c.usedAi ? ' (AI-refined)' : ''}`, '');
    if (c.warnings.length === 0) lines.push('No review items.', '');
    for (const w of c.warnings) lines.push(`- **${w.severity}**${w.line ? ` (line ${w.line})` : ''}: ${w.message}`);
    lines.push('');
  }
  if (extra.length) lines.push('## Value converters', ...extra.map((w) => `- **${w.severity}**: ${w.message}`), '');
  if (r.skipped.length) lines.push('## Skipped files', ...r.skipped.map((s) => `- \`${s.file}\`: ${s.reason}`), '');
  lines.push('## Manual steps', '- Wrap your app in `<ServiceProvider services={[[TodoService, new TodoService()]]}>` for any `useService` calls.', '- Replace Aurelia router configuration with React Router.', '- Port `main`/bootstrap code and global resources.', '');
  return lines.join('\n');
}

export { pascalCase };
