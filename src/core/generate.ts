import ts from 'typescript';
import * as prettier from 'prettier';
import { refineWithAi } from './ai.js';
import { collectAssigned, containsAwait, printNode, rewriteNode, typedParams, type RewriteCtx } from './rewrite.js';
import { convertTemplate, createTemplateCtx } from './template.js';
import type { MigrateOptions, MigrationInput, MigrationOutput, MigrationWarning } from './types.js';
import { analyzeViewModel, type VmInfo, type VmMember } from './vm.js';
import { cap, pascalCase, setterName } from './util.js';

const LIFECYCLE = new Set(['attached', 'detached', 'bind', 'unbind', 'created', 'activate', 'deactivate', 'canActivate', 'canDeactivate', 'determineActivationStrategy']);

function inferType(m: VmMember, language: 'ts' | 'js'): string | undefined {
  if (m.type) return m.type;
  const init = m.initializer?.trim();
  if (init === undefined) return language === 'ts' ? 'any' : undefined;
  if (init === '[]') return 'any[]';
  if (init === '{}') return 'Record<string, any>';
  if (init === 'null' || init === 'undefined') return 'any';
  return undefined; // let TypeScript infer
}

/** Body text (statements) of a function with `this.*` rewritten; async-safe for effects. */
function rewrittenBody(fn: ts.FunctionLikeDeclaration, ctx: RewriteCtx): { text: string; hasAwait: boolean } {
  if (!fn.body) return { text: '', hasAwait: false };
  const hasAwait = containsAwait(fn.body);
  if (ts.isBlock(fn.body)) {
    const block = rewriteNode(fn.body, ctx);
    const text = block.statements.map((s) => printNode(s, ctx.sf)).join('\n');
    return { text, hasAwait };
  }
  const expr = rewriteNode(fn.body, ctx) as ts.Expression;
  return { text: `return ${printNode(expr, ctx.sf)};`, hasAwait };
}

const paramsText = typedParams;

function effectBody(text: string, hasAwait: boolean): string {
  return hasAwait ? `void (async () => {\n${text}\n})();` : text;
}

export async function formatCode(code: string): Promise<string> {
  return prettier.format(code, { parser: 'typescript', singleQuote: true, printWidth: 100, trailingComma: 'all' });
}

export async function migrateComponent(input: MigrationInput, options: MigrateOptions = {}): Promise<MigrationOutput> {
  const language = input.language ?? 'ts';
  const warnings: MigrationWarning[] = [];
  const root = options.rootRelative ?? '.';
  const vm: VmInfo | null = input.code?.trim() ? analyzeViewModel(input.code, language) : null;
  if (input.code?.trim() && !vm) warnings.push({ severity: 'warning', message: 'No class was found in the view-model source; only the view was migrated.' });
  if (vm) warnings.push(...vm.warnings);

  const componentName = pascalCase(input.name) || vm?.className || 'Component';
  const memberNames = new Set<string>();
  vm?.members.forEach((m) => memberNames.add(m.name));
  vm?.injects.forEach((i) => memberNames.add(i.name));

  const assigned = new Set<string>();
  const sf = vm?.sourceFile;
  if (vm && sf) {
    vm.members.forEach((m) => m.fn && collectAssigned(m.fn, assigned));
    for (const st of vm.ctorExtraStatements) {
      const tmp = ts.createSourceFile('c.ts', st, ts.ScriptTarget.Latest, true);
      collectAssigned(tmp, assigned);
    }
  }

  // ---- template ----
  const tctx = createTemplateCtx({
    vmNames: memberNames,
    assigned,
    refs: new Set(),
    warnings,
    requires: options.requires ? new Map(options.requires) : new Map(),
  });
  // Discover refs first (they influence expression conversion)
  for (const m of input.html.matchAll(/\sref="([A-Za-z_$][\w$]*)"/g)) tctx.refs.add(m[1]);
  const jsx = convertTemplate(input.html, tctx);

  // ---- classify members ----
  const props: VmMember[] = [];
  const stateMembers: VmMember[] = [];
  const constMembers: VmMember[] = [];
  const getters: VmMember[] = [];
  const methods: VmMember[] = [];
  const lifecycle = new Map<string, VmMember>();
  const changed = new Map<string, VmMember>();

  const declared = new Set(vm?.members.map((m) => m.name));
  for (const m of vm?.members ?? []) {
    if (m.kind === 'method') {
      if (LIFECYCLE.has(m.name)) lifecycle.set(m.name, m);
      else if (m.name.endsWith('Changed') && declared.has(m.name.slice(0, -7))) changed.set(m.name.slice(0, -7), m);
      else methods.push(m);
    } else if (m.kind === 'getter') getters.push(m);
    else if (m.bindable) props.push(m);
    else if (tctx.refs.has(m.name)) continue;
    else if (assigned.has(m.name)) stateMembers.push(m);
    else constMembers.push(m);
  }
  // Names assigned but never declared (e.g. this.foo = 1 in a method)
  const synthetic: VmMember[] = [];
  for (const name of assigned) {
    if (!declared.has(name) && !vm?.injects.some((i) => i.name === name) && !tctx.refs.has(name) && memberNames.has(name) === false) {
      synthetic.push({ name, kind: 'property', bindable: false, observable: false, line: 0 });
      memberNames.add(name);
      warnings.push({ severity: 'warning', message: `"${name}" is assigned but never declared on the class; created as state.`, needsAi: true });
    }
  }
  stateMembers.push(...synthetic);

  const assignedBindables = props.filter((p) => assigned.has(p.name));
  if (assignedBindables.length) {
    warnings.push({
      severity: 'warning',
      message: `Bindable(s) ${assignedBindables.map((p) => `"${p.name}"`).join(', ')} are assigned inside the component; they became local state seeded from the prop. Consider a change callback prop.`,
      needsAi: true,
    });
  }

  const rctx: RewriteCtx | null = sf
    ? { members: memberNames, refs: tctx.refs, warnings, sf }
    : null;

  // ---- generate body ----
  const body: string[] = [];
  const reactImports = new Set<string>();
  const extraImports: string[] = [];

  // Services (Aurelia DI -> context)
  if (vm?.injects.length) {
    extraImports.push(`import { useService } from '${root}/services';`);
    for (const inj of vm.injects) {
      const importedLocal = vm.imports.find((im) => im.names.includes(inj.token ?? '') && !im.module.startsWith('aurelia-'));
      const token = importedLocal ? inj.token! : JSON.stringify(inj.token ?? inj.name);
      if (!importedLocal) {
        warnings.push({ severity: 'info', message: `Injected "${inj.name}" (${inj.token ?? 'unknown type'}) is resolved via useService(${token}); register it in <ServiceProvider>.`, needsAi: false });
      }
      body.push(`const ${inj.name} = useService<${importedLocal ? inj.token : 'any'}>(${token});`);
    }
  }

  // props destructuring
  const propNames: string[] = [];
  for (const p of props) {
    const alias = assigned.has(p.name) ? `${p.name}: initial${cap(p.name)}` : p.name;
    propNames.push(p.initializer ? `${alias} = ${p.initializer}` : alias);
  }
  if (tctx.usesChildren) propNames.push('children');

  // state
  for (const p of assignedBindables) {
    const t = inferType(p, language);
    body.push(`const [${p.name}, ${setterName(p.name)}] = useState${t ? `<${t}>` : ''}(initial${cap(p.name)});`);
  }
  for (const m of stateMembers) {
    const t = inferType(m, language);
    const init = m.initializer ?? 'undefined';
    const generic = t ? `<${t}${m.initializer === undefined && t !== 'any' ? ' | undefined' : ''}>` : '';
    body.push(`const [${m.name}, ${setterName(m.name)}] = useState${generic}(${init});`);
  }
  for (const m of constMembers) {
    const t = m.type ? `: ${m.type}` : '';
    body.push(`const ${m.name}${t} = ${m.initializer ?? 'undefined'};`);
    if (m.initializer === undefined) {
      warnings.push({ severity: 'info', message: `"${m.name}" is never assigned and has no initial value.` });
    }
  }
  for (const [name, type] of tctx.refTypes) {
    body.push(`const ${name} = useRef<${type}${type === 'any' ? '' : ' | null'}>(null);`);
    reactImports.add('useRef');
  }

  // getters
  for (const g of getters) {
    if (!rctx || !g.fn || !ts.isGetAccessorDeclaration(g.fn)) continue;
    const blk = g.fn.body;
    if (blk && blk.statements.length === 1 && ts.isReturnStatement(blk.statements[0]) && blk.statements[0].expression) {
      const e = rewriteNode(blk.statements[0].expression, rctx);
      body.push(`const ${g.name} = ${printNode(e, rctx.sf)};`);
    } else {
      const { text } = rewrittenBody(g.fn, rctx);
      body.push(`const ${g.name} = (() => {\n${text}\n})();`);
    }
  }

  // methods
  for (const m of methods) {
    if (!rctx || !m.fn) continue;
    const isAsync = !!m.fn.modifiers?.some((x) => x.kind === ts.SyntaxKind.AsyncKeyword);
    const { text } = rewrittenBody(m.fn, rctx);
    body.push(`${isAsync ? 'async ' : ''}function ${m.name}(${paramsText(m.fn, rctx.sf)}) {\n${text}\n}`);
  }

  // constructor leftovers
  if (vm?.ctorExtraStatements.length) {
    body.push(`// TODO(migration): constructor logic was not migrated:\n${vm.ctorExtraStatements.map((s) => s.split('\n').map((l) => `// ${l}`).join('\n')).join('\n')}`);
    warnings.push({ severity: 'warning', message: 'Constructor logic was not migrated automatically (left as a TODO comment).', needsAi: true });
  }

  // lifecycle effects
  const attached = lifecycle.get('attached');
  const detached = lifecycle.get('detached') ?? lifecycle.get('unbind');
  const mountHooks = ['bind', 'created', 'activate'].map((n) => lifecycle.get(n)).filter(Boolean) as VmMember[];
  const unsupported = ['deactivate', 'canActivate', 'canDeactivate', 'determineActivationStrategy'].filter((n) => lifecycle.has(n));
  if (unsupported.length) {
    warnings.push({ severity: 'warning', message: `Router lifecycle hook(s) ${unsupported.join(', ')} have no direct equivalent; implement with React Router loaders/guards.`, needsAi: true });
  }
  if (lifecycle.has('activate')) {
    warnings.push({ severity: 'warning', message: '`activate(params)` receives router params in Aurelia; use useParams() from React Router.', needsAi: true });
  }
  if (rctx) {
    const mounts = [...(attached ? [attached] : []), ...mountHooks];
    mounts.forEach((hook, i) => {
      if (!hook.fn) return;
      const { text, hasAwait } = rewrittenBody(hook.fn, rctx);
      const cleanup = i === 0 && detached?.fn ? rewrittenBody(detached.fn, rctx).text : '';
      const code = effectBody(text, hasAwait);
      body.push(`useEffect(() => {\n${code}\n${cleanup ? `return () => {\n${cleanup}\n};` : ''}\n}, []);`);
      reactImports.add('useEffect');
    });
    if (mounts.length === 0 && detached?.fn) {
      body.push(`useEffect(() => {\nreturn () => {\n${rewrittenBody(detached.fn, rctx).text}\n};\n}, []);`);
      reactImports.add('useEffect');
    }
    for (const [prop, m] of changed) {
      if (!m.fn) continue;
      const [newName, oldName] = m.fn.parameters.map((p) => p.name.getText(rctx.sf));
      const { text, hasAwait } = rewrittenBody(m.fn, rctx);
      const alias = newName && newName !== prop ? `const ${newName} = ${prop};\n` : '';
      if (oldName) warnings.push({ severity: 'warning', message: `${prop}Changed used the old value ("${oldName}"), which is not available in useEffect; track it with a ref.`, needsAi: true });
      warnings.push({ severity: 'info', message: `${prop}Changed became useEffect on [${prop}] and also runs once on mount.` });
      body.push(`useEffect(() => {\n${alias}${effectBody(text, hasAwait)}\n}, [${prop}]);`);
      reactImports.add('useEffect');
    }
  }

  if (stateMembers.length + assignedBindables.length) reactImports.add('useState');
  if (tctx.usesFragment) reactImports.add('Fragment');

  // ---- imports ----
  const header: string[] = [];
  if (reactImports.size) header.push(`import { ${[...reactImports].sort().join(', ')} } from 'react';`);
  for (const [name, path] of tctx.imports) header.push(`import ${name} from '${path}';`);
  for (const css of tctx.sideEffectImports) header.push(`import '${css}';`);
  if (tctx.flags.usesValueConverters) header.push(`import { valueConverters } from '${root}/valueConverters';`);
  header.push(...extraImports);
  for (const im of vm?.imports ?? []) {
    if (!im.module.startsWith('aurelia-')) header.push(im.text);
  }

  // ---- props interface ----
  let propsBlock = '';
  let sig = '()';
  if (props.length || tctx.usesChildren) {
    const fields = props.map((p) => `  ${p.name}?: ${p.type ?? (language === 'ts' ? 'any' : 'any')};`);
    if (tctx.usesChildren) fields.push('  children?: React.ReactNode;');
    propsBlock = `export interface ${componentName}Props {\n${fields.join('\n')}\n}\n\n`;
    sig = `({ ${propNames.join(', ')} }: ${componentName}Props)`;
    if (tctx.usesChildren) header.unshift(`import type * as React from 'react';`);
  }

  const noteLines = warnings
    .filter((w) => w.severity !== 'info')
    .slice(0, 25)
    .map((w) => ` * - ${w.message.replace(/\*\//g, '* /')}`);
  const noteBlock = noteLines.length
    ? `/**\n * Migrated from Aurelia by AI Migration Studio. Review before use:\n${noteLines.join('\n')}\n */\n`
    : '/** Migrated from Aurelia by AI Migration Studio. */\n';

  let tsx =
    `${header.join('\n')}\n\n${noteBlock}${propsBlock}` +
    `export default function ${componentName}${sig} {\n${body.join('\n\n')}\n\nreturn (\n${jsx}\n);\n}\n`;

  // ---- format / validate ----
  try {
    tsx = await formatCode(tsx);
  } catch (e) {
    warnings.push({ severity: 'error', message: `Generated code failed to parse: ${(e as Error).message.split('\n')[0]}`, needsAi: true });
  }

  const seen = new Set<string>();
  const unique = warnings.filter((w) => { const k = `${w.severity}|${w.line ?? ''}|${w.message}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const out: MigrationOutput = { componentName, fileName: `${componentName}.tsx`, tsx, warnings: unique, usedAi: false };

  if (options.ai && warnings.some((w) => w.needsAi || w.severity === 'error')) {
    const refined = await refineWithAi(options.ai, {
      html: input.html,
      code: input.code ?? '',
      language,
      draft: tsx,
      warnings: warnings.filter((w) => w.needsAi || w.severity === 'error'),
      componentName,
    });
    if (refined.ok) {
      out.tsx = refined.tsx;
      out.usedAi = true;
      out.warnings.push({ severity: 'info', message: 'AI refinement applied and re-validated; review the diff against the deterministic draft.' });
    } else {
      out.warnings.push({ severity: 'warning', message: `AI refinement rejected: ${refined.reason}. The deterministic draft was kept.` });
    }
  }
  return out;
}
