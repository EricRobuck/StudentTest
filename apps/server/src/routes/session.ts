import { Router } from 'express';
import type { ApiError, SessionResponse } from '@linuxlab/shared';
import { config } from '../config.js';
import { readCookie, requireAllowedOrigin, SESSION_COOKIE } from '../http/security.js';
import { ContainerError } from '../modules/containers/index.js';
import type { SessionManager } from '../modules/sessions/sessionManager.js';

// Errors whose messages are safe and useful to show the student.
const USER_FACING: Partial<Record<ContainerError['code'], number>> = {
  DOCKER_UNAVAILABLE: 503,
  IMAGE_MISSING: 503,
  CAPACITY: 503,
};

export function sessionRouter(sessions: SessionManager): Router {
  const router = Router();

  // POST /api/session — resume this browser's exam session, or start one
  // (which creates its Linux container). Called before opening the terminal.
  router.post('/session', requireAllowedOrigin(config.security.allowedOrigins), async (req, res, next) => {
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    try {
      const result = await sessions.resumeOrCreate(token);
      if (result.token !== token) {
        res.cookie(SESSION_COOKIE, result.token, {
          httpOnly: true, // page JavaScript can never read the token
          sameSite: 'strict',
          secure: config.security.cookieSecure,
          path: '/',
        });
      }
      const body: SessionResponse = { sessionId: result.session.id, resumed: result.resumed };
      res.json(body);
    } catch (err) {
      const status = err instanceof ContainerError ? USER_FACING[err.code] : undefined;
      if (err instanceof ContainerError && status) {
        const body: ApiError = { error: { code: err.code, message: err.message } };
        res.status(status).json(body);
        return;
      }
      next(err);
    }
  });

  return router;
}
