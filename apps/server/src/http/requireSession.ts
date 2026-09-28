import type { Request, RequestHandler, Response } from 'express';
import type { ApiError } from '@linuxlab/shared';
import type { ExamSession, SessionManager } from '../modules/sessions/sessionManager.js';
import { readCookie, SESSION_COOKIE } from './security.js';

/**
 * Rejects requests without a valid session cookie and makes the session
 * available to the route via sessionOf(res).
 */
export function requireSession(sessions: SessionManager): RequestHandler {
  return async (req: Request, res: Response, next) => {
    try {
      const token = readCookie(req.headers.cookie, SESSION_COOKIE);
      const session = token ? await sessions.findByToken(token) : undefined;
      if (!session) {
        const body: ApiError = { error: { code: 'NO_SESSION', message: 'No active exam session' } };
        res.status(401).json(body);
        return;
      }
      res.locals.session = session;
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function sessionOf(res: Response): ExamSession {
  return res.locals.session as ExamSession;
}
