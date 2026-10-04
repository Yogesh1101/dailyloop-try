import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { ZodError } from 'zod';
import { config } from './config';
import { GitError } from './engine/workspace';
import { configRoutes } from './routes/config';
import type { AppContext } from './routes/context';
import { runRoutes } from './routes/runs';
import { systemRoutes } from './routes/system';
import { HttpError } from './util/misc';

export function createApp(ctx: AppContext) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '4mb' }));

  // Bound to loopback: refuse other Host headers so a malicious page cannot reach the API via DNS rebinding.
  const loopback = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
  if (loopback.test(config.host) || config.host === '::1') {
    app.use((req, res, next) => (loopback.test(req.headers.host ?? '') ? next() : res.status(421).json({ error: 'Unexpected Host header' })));
  }

  // The API runs agents against local repositories: only same-machine browser origins may call it.
  app.use('/api', (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) {
      return res.status(403).json({ error: 'Cross-origin requests are not allowed' });
    }
    next();
  });

  app.use('/api', systemRoutes(ctx));
  app.use('/api', configRoutes(ctx));
  app.use('/api', runRoutes(ctx));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  if (fs.existsSync(path.join(config.clientDist, 'index.html'))) {
    app.use(express.static(config.clientDist));
    app.get('/{*splat}', (_req, res) => res.sendFile(path.join(config.clientDist, 'index.html')));
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      return res.status(400).json({
        error: 'Validation failed',
        issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, details: err.details });
    if (err instanceof GitError) return res.status(400).json({ error: err.message });
    if (err && typeof err === 'object' && (err as { code?: number }).code === 11000) {
      return res.status(409).json({ error: 'An item with this key already exists' });
    }
    if (err && typeof err === 'object' && (err as { type?: string }).type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Malformed JSON body' });
    }
    console.error(err);
    res.status(500).json({ error: (err as Error)?.message ?? 'Internal error' });
  });
  return app;
}
