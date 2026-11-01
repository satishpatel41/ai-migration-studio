import { describe, expect, it } from 'vitest';
import { migrateComponent } from '../src/core/generate.js';

const run = (html: string, code?: string, language: 'ts' | 'js' = 'ts') =>
  migrateComponent({ name: 'demo-widget', html, code, language });

describe('template conversion', () => {
  it('converts interpolation, if.bind, show.bind, repeat.for and class bindings', async () => {
    const r = await run(
      `<template><div class="a" if.bind="ok"><p show.bind="visible" class.bind="cls">\${msg}</p>
       <ul><li repeat.for="x of xs" active.class="x.on">\${x.name}</li></ul></div></template>`,
      `export class DemoWidget { ok = true; visible = false; cls = 'c'; msg = 'hi'; xs = []; }`,
    );
    expect(r.tsx).toContain('{ok && (');
    expect(r.tsx).toContain("display: 'none'");
    expect(r.tsx).toContain('{msg}');
    expect(r.tsx).toContain('xs.map((x, $index)');
    expect(r.tsx).toContain('key={$index}');
    expect(r.tsx).toContain("'active'");
    expect(r.warnings.some((w) => w.severity === 'error')).toBe(false);
  });

  it('maps events and prevents default on submit', async () => {
    const r = await run(
      `<form submit.delegate="save($event)"><button type="button" click.trigger="go()">x</button></form>`,
      `export class DemoWidget { save(e) {} go() {} }`,
    );
    expect(r.tsx).toContain('onSubmit={(event) => {');
    expect(r.tsx).toContain('event.preventDefault()');
    expect(r.tsx).toContain('save(event)');
    expect(r.tsx).toContain('onClick={() => go()}');
  });

  it('creates two-way input handlers with immutable nested updates', async () => {
    const r = await run(
      `<input value.bind="user.address.city"><input type="checkbox" checked.bind="agree">`,
      `export class DemoWidget { user = { address: { city: '' } }; agree = false; }`,
    );
    expect(r.tsx).toContain('setUser({ ...user, address: { ...user.address, city: event.target.value } })');
    expect(r.tsx).toContain('setAgree(event.target.checked)');
    expect(r.tsx).toContain('useState(false)');
  });

  it('converts radio groups with model.bind', async () => {
    const r = await run(
      `<input type="radio" name="g" model.bind="'a'" checked.bind="choice">`,
      `export class DemoWidget { choice = 'a'; }`,
    );
    expect(r.tsx).toContain("checked={choice === 'a'}");
    expect(r.tsx).toContain("setChoice('a')");
  });

  it('maps native attribute names and static style', async () => {
    const r = await run(`<label for="x" style="margin-top: 4px; color: red">L</label><input id="x" tabindex="2" readonly>`);
    expect(r.tsx).toContain('htmlFor="x"');
    expect(r.tsx).toContain('tabIndex="2"');
    expect(r.tsx).toContain("marginTop: '4px'");
    expect(r.tsx).toContain('readOnly');
  });

  it('turns custom elements into imported components and <slot> into children', async () => {
    const r = await run(`<template><require from="./parts/my-card"></require><my-card title.bind="t"><slot></slot></my-card></template>`, `export class DemoWidget { t = 'x'; }`);
    expect(r.tsx).toContain("import MyCard from './parts/MyCard'");
    expect(r.tsx).toContain('<MyCard title={t}>');
    expect(r.tsx).toContain('{children}');
  });

  it('flags value converters and binding behaviors', async () => {
    const r = await run(`<p>\${n | currency:'USD' & debounce:200}</p>`, `export class DemoWidget { n = 1; }`);
    expect(r.tsx).toContain("valueConverters.currency(n, 'USD')");
    expect(r.warnings.some((w) => /Binding behavior/.test(w.message))).toBe(true);
  });

  it('warns about unresolved identifiers instead of guessing', async () => {
    const r = await run(`<p>\${nope}</p>`, `export class DemoWidget { a = 1; }`);
    expect(r.warnings.some((w) => /"nope"/.test(w.message))).toBe(true);
  });

  it('warns on router/compose elements', async () => {
    const r = await run(`<router-view></router-view><compose view-model.bind="vm"></compose>`);
    expect(r.warnings.filter((w) => w.needsAi).length).toBeGreaterThanOrEqual(2);
  });

  it('escapes braces and entities in static text', async () => {
    const r = await run(`<p>a &amp; b { c }</p>`);
    expect(r.warnings.some((w) => w.severity === 'error')).toBe(false);
    expect(r.tsx).toContain("a &amp; b {'{'} c {'}'}");
  });
});

describe('view-model conversion', () => {
  it('turns bindables into props with defaults and children', async () => {
    const r = await run(`<p>\${label}</p>`, `import {bindable} from 'aurelia-framework';\nexport class DemoWidget { @bindable label = 'Hi'; @bindable count: number; }`);
    expect(r.tsx).toContain('export interface DemoWidgetProps');
    expect(r.tsx).toContain("label = 'Hi'");
    expect(r.tsx).toContain('count?: number');
  });

  it('rewrites assignments, compound ops, increments, and array mutators', async () => {
    const r = await run(
      `<p>\${n}</p>`,
      `export class DemoWidget {
        n = 0; items = []; user = { name: '' };
        inc() { this.n++; this.n += 2; this.user.name = 'z'; this.items.push(1, 2); this.items.unshift(0); }
      }`,
    );
    expect(r.tsx).toContain('setN(n + 1)');
    expect(r.tsx).toContain('setN(n + 2)');
    expect(r.tsx).toContain("setUser({ ...user, name: 'z' })");
    expect(r.tsx).toContain('setItems([...items, 1, 2])');
    expect(r.tsx).toContain('setItems([0, ...items])');
  });

  it('warns (needsAi) on in-place mutation it cannot rewrite', async () => {
    const r = await run(`<p></p>`, `export class DemoWidget { items = []; go() { this.items.sort(); } }`);
    expect(r.warnings.some((w) => /In-place `sort`/.test(w.message) && w.needsAi)).toBe(true);
  });

  it('maps attached/detached to one effect with cleanup and wraps await', async () => {
    const r = await run(
      `<p></p>`,
      `export class DemoWidget { async attached() { await load(); } detached() { stop(); } }`,
    );
    expect(r.tsx).toContain('void (async () => {');
    expect(r.tsx).toMatch(/return \(\) => \{\s*stop\(\);/);
    expect(r.tsx.match(/useEffect\(/g)).toHaveLength(1);
  });

  it('maps getters to derived constants and refs to useRef', async () => {
    const r = await run(
      `<input ref="box"><p>\${total}</p>`,
      `export class DemoWidget { items = [1]; box; get total() { return this.items.length; } focus() { this.box.focus(); } }`,
    );
    expect(r.tsx).toContain('const total = items.length;');
    expect(r.tsx).toContain('useRef<HTMLInputElement | null>(null)');
    expect(r.tsx).toContain('box.current.focus()');
  });

  it('replaces Aurelia DI with useService and keeps non-Aurelia imports', async () => {
    const r = await run(
      `<p></p>`,
      `import {inject} from 'aurelia-framework';\nimport {HttpClient} from 'aurelia-fetch-client';\nimport moment from 'moment';\n@inject(HttpClient)\nexport class DemoWidget { constructor(http) { this.http = http; } }`,
      'js',
    );
    expect(r.tsx).toContain("useService<any>('HttpClient')");
    expect(r.tsx).toContain("import moment from 'moment'");
    expect(r.tsx).not.toContain('aurelia-');
  });

  it('does not fabricate when the view-model has no class', async () => {
    const r = await run(`<p>hi</p>`, `export const x = 1;`);
    expect(r.warnings.some((w) => /No class/.test(w.message))).toBe(true);
  });

  it('supports numeric ranges in repeat.for', async () => {
    const r = await run(`<template><div repeat.for="i of 3">\${$index}</div></template>`);
    expect(r.warnings.filter((w) => w.severity === 'error')).toEqual([]);
    expect(r.tsx).toContain('Array.from({ length: 3 }');
  });
});
