import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createStudioApp } from '../src/studio/server.js';

const html = '<template><h1>${title}</h1><button click.delegate="inc()">+</button></template>';
const code = 'export class Counter { title = "Hi"; n = 0; inc() { this.n++; } }';

describe('studio API', () => {
  it('reports AI configuration state', async () => {
    const app = createStudioApp({ aiEnabled: () => false });
    expect((await request(app).get('/api/config')).body).toEqual({ aiConfigured: false });
  });

  it('migrates a view and view-model', async () => {
    const app = createStudioApp({ aiEnabled: () => false });
    const r = await request(app).post('/api/migrate').send({ name: 'counter', html, code, language: 'js' });
    expect(r.status).toBe(200);
    expect(r.body.fileName).toBe('Counter.tsx');
    expect(r.body.tsx).toContain('setN(n + 1)');
    expect(r.body.usedAi).toBe(false);
  });

  it('rejects invalid input', async () => {
    const app = createStudioApp({ aiEnabled: () => false });
    expect((await request(app).post('/api/migrate').send({ html: '' })).status).toBe(400);
    expect((await request(app).post('/api/migrate').send({ name: '../x', html })).status).toBe(400);
  });

  it('returns 503 when AI is requested but not configured (no silent fallback)', async () => {
    const app = createStudioApp({ aiEnabled: () => false });
    const r = await request(app).post('/api/migrate').send({ html, code, useAi: true });
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('AI_NOT_CONFIGURED');
  });

  it('uses the AI provider when configured and requested', async () => {
    const reply = '```tsx\nexport default function Component() { return <p>ai</p>; }\n```';
    const app = createStudioApp({ aiEnabled: () => true, aiFactory: () => ({ name: 'mock', complete: async () => reply }) });
    const r = await request(app).post('/api/migrate').send({ html: '<compose></compose>', useAi: true });
    expect(r.status).toBe(200);
    expect(r.body.usedAi).toBe(true);
  });

  it('serves the studio page', async () => {
    const app = createStudioApp({ aiEnabled: () => false });
    const r = await request(app).get('/');
    expect(r.status).toBe(200);
    expect(r.text).toContain('AI Migration Studio');
  });
});
