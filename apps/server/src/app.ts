import express, { type ErrorRequestHandler, type Express } from 'express';
import { config } from './config.js';
import { sendError } from './http/errors.js';
import { createLimiters } from './http/rateLimit.js';
import { securityHeaders } from './http/securityHeaders.js';
import type { AttemptService } from './modules/attempts/attemptService.js';
import type { ContainerRuntime } from './modules/containers/index.js';
import type { InstructorAuth } from './modules/instructor/instructorAuth.js';
import type { InstructorService } from './modules/instructor/instructorService.js';
import type { SessionManager } from './modules/sessions/sessionManager.js';
import { attemptRouter } from './routes/attempt.js';
import { examRouter } from './routes/exam.js';
import { healthRouter } from './routes/health.js';
import { instructorRouter } from './routes/instructor.js';
import { sessionRouter } from './routes/session.js';

export interface AppDeps {
  runtime: ContainerRuntime;
  sessions: SessionManager;
  attempts: AttemptService;
  instructorAuth: InstructorAuth;
  instructor: InstructorService;
}

/** Builds the Express app without listening, so it can be tested in isolation. */
export function createApp({ runtime, sessions, attempts, instructorAuth, instructor }: AppDeps): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(securityHeaders);
  // No endpoint needs more than a few hundred bytes of JSON.
  app.use(express.json({ limit: '16kb' }));

  const limiters = createLimiters(config.security.rateLimits);
  app.use('/api', healthRouter(runtime));
  app.use('/api', sessionRouter(sessions, attempts, limiters));
  app.use('/api', examRouter({ sessions, attempts, runtime, limiters }));
  app.use('/api', attemptRouter(sessions, attempts, limiters));
  app.use('/api', instructorRouter(instructorAuth, instructor));

  // The backend only serves /api and /ws. Anyone who opens it directly in a
  // browser is sent to the web app instead of seeing "Cannot GET /".
  app.get('/', (_req, res) => {
    res.redirect(config.webUrl);
  });

  app.use('/api', (_req, res) => sendError(res, 404, 'NOT_FOUND', 'Endpoint not found'));

  // Never leak stack traces or internal details to the browser.
  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    const type = (err as { type?: string }).type;
    if (type === 'entity.parse.failed') return sendError(res, 400, 'BAD_REQUEST', 'Malformed JSON body');
    if (type === 'entity.too.large') return sendError(res, 413, 'TOO_LARGE', 'Request body too large');
    console.error('[server] unhandled error:', err);
    sendError(res, 500, 'INTERNAL', 'Internal server error');
  };
  app.use(errorHandler);

  return app;
}
