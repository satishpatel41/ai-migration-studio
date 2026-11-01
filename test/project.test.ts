import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { migrateProject } from '../src/core/project.js';

const fixture = path.join(__dirname, 'fixtures', 'sample-app');
const out = path.join(os.tmpdir(), `ams-test-${process.pid}`);

afterAll(async () => { await fs.rm(out, { recursive: true, force: true }); });

describe('project migration', () => {
  it('migrates the sample Aurelia app end to end', async () => {
    const r = await migrateProject(fixture, out);
    expect(r.components.map((c) => c.output).sort()).toEqual(['App.tsx', 'TodoItem.tsx']);
    expect(r.valueConverters).toEqual(['pluralize-value-converter.js']);
    expect(r.skipped.map((s) => s.file)).toContain('todo-service.js');
    for (const c of r.components) expect(c.warnings.filter((w) => w.severity === 'error')).toEqual([]);

    const app = await fs.readFile(path.join(out, 'App.tsx'), 'utf8');
    expect(app).toContain("import TodoItem from './TodoItem'");
    expect(app).toContain("import './app.css'");
    expect(app).toContain('useService<TodoService>(TodoService)');
    expect(app).toContain('setTodos([...todos, {');
    expect(app).toContain('valueConverters.pluralize(remaining, \'item\')');

    const item = await fs.readFile(path.join(out, 'TodoItem.tsx'), 'utf8');
    expect(item).toContain('export interface TodoItemProps');
    expect(item).toContain('onDoubleClick');

    expect(await fs.readFile(path.join(out, 'services.tsx'), 'utf8')).toContain('export function useService');
    const conv = await fs.readFile(path.join(out, 'valueConverters.ts'), 'utf8');
    expect(conv).toContain('export function pluralize(count: any, word: any)');
    expect(conv).toContain('export const valueConverters = { pluralize }');
    const report = await fs.readFile(path.join(out, 'MIGRATION_REPORT.md'), 'utf8');
    expect(report).toContain('Components migrated: **2**');
  });
});
