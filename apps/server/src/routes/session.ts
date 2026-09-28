import { Router, type NextFunction, type Request, type Response } from 'express';
import { validateStudentInfo, type ClassListResponse, type SessionResponse, type StudentInfo } from '@linuxlab/shared';
import { config } from '../config.js';
import { sendError } from '../http/errors.js';
import { clientAddress, sendRateLimited, type Limiters } from '../http/rateLimit.js';
import { requireSession, sessionOf } from '../http/requireSession.js';
import { readCookie, requireAllowedOrigin, SESSION_COOKIE } from '../http/security.js';
import type { AttemptService } from '../modules/attempts/attemptService.js';
import { ContainerError } from '../modules/containers/index.js';
import { getActiveExam, getExamById } from '../modules/exams/examService.js';
import type { SessionManager, SessionResult } from '../modules/sessions/sessionManager.js';

// Errors whose messages are safe and useful to show the student.
const USER_FACING: Partial<Record<ContainerError['code'], number>> = {
  DOCKER_UNAVAILABLE: 503,
  IMAGE_MISSING: 503,
  CAPACITY: 503,
};

const NEW_SESSION_LIMIT_MESSAGE = 'Too many new exam sessions from your network. Please wait a few minutes.';

export function sessionRouter(sessions: SessionManager, attempts: AttemptService, limiters: Limiters): Router {
  const router = Router();
  const sameOrigin = requireAllowedOrigin(config.security.allowedOrigins);

  /** Creating a session creates a container: the one expensive, rate-limited action. */
  const allowNewSession = (req: Request, res: Response): boolean => {
    const retryAfter = limiters.newSessions.hit(clientAddress(req));
    if (retryAfter > 0) sendRateLimited(res, retryAfter, NEW_SESSION_LIMIT_MESSAGE);
    return retryAfter === 0;
  };

  // GET /api/classes — what the start screen offers (null = students type their class).
  router.get('/classes', (_req, res) => {
    const body: ClassListResponse = { classes: config.classes };
    res.json(body);
  });

  // POST /api/session — resume this browser's session. 401 NO_SESSION means
  // "no session yet": the browser shows the start screen. Never creates one.
  router.post('/session', sameOrigin, async (req, res, next) => {
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    try {
      const result = await sessions.resume(token);
      if (!result) return sendError(res, 401, 'NO_SESSION', 'No exam session yet');
      respond(res, result, token);
    } catch (err) {
      handleError(err, res, next);
    }
  });

  // POST /api/session/start { name, className } — the start screen.
  router.post('/session/start', sameOrigin, async (req, res, next) => {
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    try {
      const checked = validateStudentInfo(req.body, config.classes);
      if (!checked.ok) {
        return sendError(res, 400, 'INVALID_STUDENT_INFO', Object.values(checked.errors).join(' '));
      }

      const existing = await sessions.resume(token);
      if (existing?.attemptStatus === 'in_progress' && token) {
        // Double click, second tab, or an exam that began before names were
        // asked: keep the exam already running (and record the name if missing).
        const named = await sessions.nameUnnamedAttempt(token, checked.value);
        return respond(res, named ?? existing, token);
      }
      if (existing && getActiveExam().settings.mode !== 'practice') {
        return sendError(res, 403, 'NO_RETAKE', 'This exam can only be taken once');
      }
      if (!allowNewSession(req, res)) return;
      respond(res, await sessions.start(checked.value), token);
    } catch (err) {
      handleError(err, res, next);
    }
  });

  // POST /api/session/new-attempt — after finishing a PRACTICE exam, start
  // over with a fresh attempt and Linux environment (same name and class).
  router.post('/session/new-attempt', sameOrigin, requireSession(sessions), async (req, res, next) => {
    try {
      const attempt = await attempts.get(sessionOf(res).attemptId);
      if (attempt?.status !== 'completed') {
        return sendError(res, 409, 'IN_PROGRESS', 'Finish the current attempt first');
      }
      if (getExamById(attempt.examId)?.settings.mode !== 'practice') {
        return sendError(res, 403, 'NO_RETAKE', 'This exam can only be taken once');
      }
      const student: StudentInfo | undefined = await sessions.studentOf(attempt.id);
      if (!student) return sendError(res, 409, 'NO_STUDENT', 'Start a new exam from the start screen');
      if (!allowNewSession(req, res)) return;
      respond(res, await sessions.start(student), undefined);
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
    student: result.student,
  };
  res.json(body);
}

function handleError(err: unknown, res: Response, next: NextFunction): void {
  const status = err instanceof ContainerError ? USER_FACING[err.code] : undefined;
  if (err instanceof ContainerError && status) return sendError(res, status, err.code, err.message);
  next(err);
}
