import express, { type ErrorRequestHandler, type Express } from 'express';
import type { ApiError } from '@linuxlab/shared';
import { config } from './config.js';
import type { ContainerRuntime } from './modules/containers/index.js';
import type { SessionManager } from './modules/sessions/sessionManager.js';
import { examRouter } from './routes/exam.js';
import { healthRouter } from './routes/health.js';
import { sessionRouter } from './routes/session.js';

export interface AppDeps {
  runtime: ContainerRuntime;
  sessions: SessionManager;
}

/** Builds the Express app without listening, so it can be tested in isolation. */
export function createApp({ runtime, sessions }: AppDeps): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  app.use('/api', healthRouter(runtime));
  app.use('/api', sessionRouter(sessions));
  app.use('/api', examRouter(sessions, runtime));

  // The backend only serves /api and /ws. Anyone who opens it directly in a
  // browser is sent to the web app instead of seeing "Cannot GET /".
  app.get('/', (_req, res) => {
    res.redirect(config.webUrl);
  });

  app.use('/api', (_req, res) => {
    const body: ApiError = { error: { code: 'NOT_FOUND', message: 'Endpoint not found' } };
    res.status(404).json(body);
  });

  // Never leak stack traces or internal details to the browser.
  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    console.error('[server] unhandled error:', err);
    const body: ApiError = { error: { code: 'INTERNAL', message: 'Internal server error' } };
    res.status(500).json(body);
  };
  app.use(errorHandler);

  return app;
}
