import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import express from 'express';
import { z } from 'zod';
import { aiConfigured, getAiProvider, type AiProvider } from '../core/ai.js';
import { migrateComponent } from '../core/generate.js';

const body = z.object({
  name: z.string().regex(/^[A-Za-z][\w-]{0,60}$/).default('component'),
  html: z.string().min(1).max(200_000),
  code: z.string().max(200_000).optional(),
  language: z.enum(['ts', 'js']).default('js'),
  useAi: z.boolean().default(false),
});

export interface StudioOptions {
  /** Override for tests; default builds from ANTHROPIC_API_KEY when AI is requested. */
  aiFactory?: () => AiProvider;
  aiEnabled?: () => boolean;
}

export function createStudioApp(opts: StudioOptions = {}) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  const enabled = opts.aiEnabled ?? (() => aiConfigured());
  const factory = opts.aiFactory ?? (() => getAiProvider());

  app.get('/api/config', (_req, res) => res.json({ aiConfigured: enabled() }));

  app.post('/api/migrate', async (req, res) => {
    const p = body.safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: 'Invalid request', details: p.error.flatten().fieldErrors });
    if (p.data.useAi && !enabled()) {
      return res.status(503).json({ error: 'AI refinement is not configured (ANTHROPIC_API_KEY is not set).', code: 'AI_NOT_CONFIGURED' });
    }
    try {
      const out = await migrateComponent(
        { name: p.data.name, html: p.data.html, code: p.data.code, language: p.data.language },
        { ai: p.data.useAi ? factory() : undefined },
      );
      res.json(out);
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Migration failed unexpectedly' });
    }
  });

  app.use(express.static(fileURLToPath(new URL('../../public', import.meta.url))));
  return app;
}

export function startStudio(port: number): Promise<Server> {
  return new Promise((resolve) => {
    const server = createStudioApp().listen(port, () => resolve(server));
  });
}
