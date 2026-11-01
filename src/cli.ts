#!/usr/bin/env node
import { AiNotConfiguredError, aiConfigured, getAiProvider } from './core/ai.js';
import { migrateProject } from './core/project.js';
import { startStudio } from './studio/server.js';

const HELP = `AI Migration Studio — Aurelia 1 to React + TypeScript

Usage:
  ams migrate <srcDir> --out <dir> [--ai]   Migrate every view/view-model pair in <srcDir>
  ams studio [--port 4100]                   Start the web studio
  ams --help

Options:
  --out <dir>   Output directory (default: ./migrated-out)
  --ai          Refine items flagged "needs review" with Claude (requires ANTHROPIC_API_KEY)
  --port <n>    Studio port (default 4100)

Env: ANTHROPIC_API_KEY, AMS_MODEL (default claude-sonnet-5-5)
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log(HELP);
    return cmd ? 0 : 1;
  }
  if (cmd === 'migrate') {
    const src = rest.find((a) => !a.startsWith('--') && a !== flag(rest, '--out'));
    if (!src) { console.error('Missing <srcDir>.\n\n' + HELP); return 1; }
    const out = flag(rest, '--out') ?? './migrated-out';
    let ai;
    if (rest.includes('--ai')) {
      try { ai = getAiProvider(); } catch (e) {
        if (e instanceof AiNotConfiguredError) { console.error(e.message); return 2; }
        throw e;
      }
    }
    const r = await migrateProject(src, out, { ai });
    const review = r.components.reduce((n, c) => n + c.warnings.filter((w) => w.severity !== 'info').length, 0);
    console.log(`Migrated ${r.components.length} component(s), ${r.valueConverters.length} value converter(s) -> ${out}`);
    console.log(`${review} item(s) need review. Skipped ${r.skipped.length} file(s). See ${r.reportPath}`);
    return 0;
  }
  if (cmd === 'studio') {
    const port = Number(flag(rest, '--port') ?? process.env.PORT ?? 4100);
    await startStudio(port);
    console.log(`Studio running at http://localhost:${port} (AI ${aiConfigured() ? 'enabled' : 'not configured'})`);
    return -1; // keep running
  }
  console.error(`Unknown command: ${cmd}\n\n${HELP}`);
  return 1;
}

main(process.argv.slice(2)).then((code) => { if (code >= 0) process.exit(code); }).catch((e) => { console.error(e); process.exit(1); });
