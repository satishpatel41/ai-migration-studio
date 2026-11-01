import { promises as fs } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';
import { migrateProject } from '../src/core/project.js';

// Inside the repo so module resolution finds node_modules/react and @types/react.
const out = path.join(__dirname, '.tmp-compile');
afterAll(async () => { await fs.rm(out, { recursive: true, force: true }); });

describe('generated output compiles', () => {
  it('type-checks the migrated sample app under strict TypeScript', async () => {
    await fs.rm(out, { recursive: true, force: true });
    await migrateProject(path.join(__dirname, 'fixtures', 'sample-app'), out);
    await fs.writeFile(path.join(out, 'todo-service.ts'), 'export class TodoService { async load(): Promise<any[]> { return []; } }\n');
    await fs.writeFile(path.join(out, 'globals.d.ts'), "declare module '*.css';\n");
    await fs.writeFile(path.join(out, 'app.css'), '');

    const files = (await fs.readdir(out)).filter((f) => /\.(tsx?|d\.ts)$/.test(f)).map((f) => path.join(out, f));
    const program = ts.createProgram(files, {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.ReactJSX, strict: true, noEmit: true, skipLibCheck: true,
    });
    const diags = ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
    expect(diags).toEqual([]);
  }, 60_000);
});
