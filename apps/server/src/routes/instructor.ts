import { Router } from 'express';
import type { AttemptDetail, AttemptSummary, InstructorStatus } from '@linuxlab/shared';
import { config } from '../config.js';
import { sendError } from '../http/errors.js';
import { INSTRUCTOR_COOKIE, requireInstructor } from '../http/requireInstructor.js';
import { readCookie, requireAllowedOrigin } from '../http/security.js';
import type { InstructorAuth } from '../modules/instructor/instructorAuth.js';
import type { InstructorService } from '../modules/instructor/instructorService.js';

const ATTEMPT_ID = /^[0-9a-f-]{36}$/;

export function instructorRouter(auth: InstructorAuth, service: InstructorService): Router {
  const router = Router();
  const sameOrigin = requireAllowedOrigin(config.security.allowedOrigins);
  const instructorOnly = requireInstructor(auth);

  router.get('/instructor/me', (req, res) => {
    const body: InstructorStatus = {
      enabled: auth.enabled,
      authenticated: auth.isValid(readCookie(req.headers.cookie, INSTRUCTOR_COOKIE)),
    };
    res.json(body);
  });

  router.post('/instructor/login', sameOrigin, (req, res) => {
    const password: unknown = (req.body as { password?: unknown } | undefined)?.password;
    if (typeof password !== 'string' || password.length === 0 || password.length > 200) {
      return sendError(res, 400, 'BAD_REQUEST', 'Password is required');
    }
    const outcome = auth.login(password, req.socket.remoteAddress ?? 'unknown');
    if (!outcome.ok) {
      if (outcome.reason === 'disabled') {
        return sendError(res, 503, 'INSTRUCTOR_DISABLED', 'Instructor access is not configured on this server (INSTRUCTOR_PASSWORD).');
      }
      if (outcome.reason === 'rate-limited') {
        return sendError(res, 429, 'RATE_LIMITED', 'Too many failed attempts. Try again in 15 minutes.');
      }
      return sendError(res, 401, 'INVALID_PASSWORD', 'Incorrect password');
    }
    res.cookie(INSTRUCTOR_COOKIE, outcome.token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: config.security.cookieSecure,
      path: '/',
      maxAge: 8 * 60 * 60 * 1000,
    });
    res.status(204).end();
  });

  router.post('/instructor/logout', sameOrigin, (req, res) => {
    auth.logout(readCookie(req.headers.cookie, INSTRUCTOR_COOKIE));
    res.clearCookie(INSTRUCTOR_COOKIE, { path: '/' });
    res.status(204).end();
  });

  router.get('/instructor/attempts', instructorOnly, async (_req, res, next) => {
    try {
      const body: AttemptSummary[] = await service.listAttempts();
      res.json(body);
    } catch (err) {
      next(err);
    }
  });

  router.get('/instructor/attempts/:attemptId', instructorOnly, async (req, res, next) => {
    const attemptId = String(req.params.attemptId);
    if (!ATTEMPT_ID.test(attemptId)) return sendError(res, 400, 'BAD_REQUEST', 'Invalid attempt id');
    try {
      const body: AttemptDetail | undefined = await service.attemptDetail(attemptId);
      if (!body) return sendError(res, 404, 'NOT_FOUND', 'Attempt not found');
      res.json(body);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
