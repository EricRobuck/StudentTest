import { Router, type NextFunction, type Response } from 'express';
import type { SessionResponse } from '@linuxlab/shared';
import { config } from '../config.js';
import { sendError } from '../http/errors.js';
import { requireSession, sessionOf } from '../http/requireSession.js';
import { readCookie, requireAllowedOrigin, SESSION_COOKIE } from '../http/security.js';
import type { AttemptService } from '../modules/attempts/attemptService.js';
import { ContainerError } from '../modules/containers/index.js';
import { getExamById } from '../modules/exams/examService.js';
import type { SessionManager } from '../modules/sessions/sessionManager.js';

// Errors whose messages are safe and useful to show the student.
const USER_FACING: Partial<Record<ContainerError['code'], number>> = {
  DOCKER_UNAVAILABLE: 503,
  IMAGE_MISSING: 503,
  CAPACITY: 503,
};

type SessionResult = Awaited<ReturnType<SessionManager['resumeOrCreate']>>;

export function sessionRouter(sessions: SessionManager, attempts: AttemptService): Router {
  const router = Router();
  const sameOrigin = requireAllowedOrigin(config.security.allowedOrigins);

  // POST /api/session — resume this browser's exam session, or start a new
  // attempt (which creates its Linux container). Called before anything else.
  router.post('/session', sameOrigin, async (req, res, next) => {
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    try {
      respond(res, await sessions.resumeOrCreate(token), token);
    } catch (err) {
      handleError(err, res, next);
    }
  });

  // POST /api/session/new-attempt — after finishing a PRACTICE exam, start
  // over with a fresh attempt and Linux environment. Refused for real exams.
  router.post('/session/new-attempt', sameOrigin, requireSession(sessions), async (_req, res, next) => {
    try {
      const attempt = await attempts.get(sessionOf(res).attemptId);
      if (attempt?.status !== 'completed') {
        return sendError(res, 409, 'IN_PROGRESS', 'Finish the current attempt first');
      }
      if (getExamById(attempt.examId)?.settings.mode !== 'practice') {
        return sendError(res, 403, 'NO_RETAKE', 'This exam can only be taken once');
      }
      // No token: a brand-new session (new cookie) with a new attempt.
      respond(res, await sessions.resumeOrCreate(undefined), undefined);
    } catch (err) {
      handleError(err, res, next);
    }
  });

  return router;
}

function respond(res: Response, result: SessionResult, previousToken: string | undefined): void {
  if (result.token !== previousToken) {
    res.cookie(SESSION_COOKIE, result.token, {
      httpOnly: true, // page JavaScript can never read the token
      sameSite: 'strict',
      secure: config.security.cookieSecure,
      path: '/',
    });
  }
  const body: SessionResponse = {
    sessionId: result.session.id,
    resumed: result.resumed,
    attemptStatus: result.attemptStatus,
    environmentReset: result.environmentReset,
  };
  res.json(body);
}

function handleError(err: unknown, res: Response, next: NextFunction): void {
  const status = err instanceof ContainerError ? USER_FACING[err.code] : undefined;
  if (err instanceof ContainerError && status) return sendError(res, status, err.code, err.message);
  next(err);
}
