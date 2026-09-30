import { Router, type NextFunction, type Request, type Response } from 'express';
import { validateStudentInfo, type SessionResponse, type StartOptionsResponse, type StudentInfo } from '@linuxlab/shared';
import { config } from '../config.js';
import { sendError } from '../http/errors.js';
import { clientAddress, sendRateLimited, type Limiters } from '../http/rateLimit.js';
import { requireSession, sessionOf } from '../http/requireSession.js';
import { readCookie, requireAllowedOrigin, SESSION_COOKIE } from '../http/security.js';
import type { AttemptService } from '../modules/attempts/attemptService.js';
import { ContainerError } from '../modules/containers/index.js';
import { examForAttempt, getOpenExams } from '../modules/exams/examService.js';
import { ExamNotOpenError, type SessionManager, type SessionResult } from '../modules/sessions/sessionManager.js';

// Errors whose messages are safe and useful to show the student.
const USER_FACING: Partial<Record<ContainerError['code'], number>> = {
  DOCKER_UNAVAILABLE: 503,
  IMAGE_MISSING: 503,
  CAPACITY: 503,
};

const EXAM_ID = /^[A-Za-z0-9_-]{1,100}$/;

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

  // GET /api/start-options — what the start screen offers: the class list
  // (null = students type their class) and the tests that are open right now.
  router.get('/start-options', (_req, res) => {
    const body: StartOptionsResponse = {
      classes: config.classes,
      exams: getOpenExams().map((e) => ({
        id: e.id,
        title: e.title,
        description: e.description ?? null,
        questionCount: e.questions.length,
        totalPoints: e.questions.reduce((sum, q) => sum + q.points, 0),
        timeLimitMinutes: e.settings.timeLimitMinutes,
        mode: e.settings.mode,
        lockOnLeave: e.settings.lockOnLeave !== false,
      })),
    };
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

  // POST /api/session/start { name, className, examId } — the start screen.
  router.post('/session/start', sameOrigin, async (req, res, next) => {
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    try {
      const checked = validateStudentInfo(req.body, config.classes);
      if (!checked.ok) {
        return sendError(res, 400, 'INVALID_STUDENT_INFO', Object.values(checked.errors).join(' '));
      }
      const examId: unknown = (req.body as { examId?: unknown } | undefined)?.examId;
      if (typeof examId !== 'string' || !EXAM_ID.test(examId)) {
        return sendError(res, 400, 'INVALID_EXAM', 'Please choose a test.');
      }

      const existing = await sessions.resume(token);
      if (existing?.attemptStatus === 'in_progress' && token) {
        // Double click, second tab, or an exam that began before names were
        // asked: keep the exam already running (and record the name if missing).
        const named = await sessions.nameUnnamedAttempt(token, checked.value);
        return respond(res, named ?? existing, token);
      }
      if (existing) {
        // Finished before: a real (exam-mode) test can't be retaken; others can.
        const previous = await attempts.get(existing.session.attemptId);
        const previousExam = previous && examForAttempt(previous);
        if (previous?.examId === examId && previousExam?.settings.mode !== 'practice') {
          return sendError(res, 403, 'NO_RETAKE', 'You have already taken this test. Please choose another one.');
        }
      }
      if (!allowNewSession(req, res)) return;
      respond(res, await sessions.start(checked.value, examId), token);
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
      if (examForAttempt(attempt)?.settings.mode !== 'practice') {
        return sendError(res, 403, 'NO_RETAKE', 'This exam can only be taken once');
      }
      const student: StudentInfo | undefined = await sessions.studentOf(attempt.id);
      if (!student) return sendError(res, 409, 'NO_STUDENT', 'Start a new exam from the start screen');
      if (!allowNewSession(req, res)) return;
      respond(res, await sessions.start(student, attempt.examId), undefined);
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
  if (err instanceof ExamNotOpenError) return sendError(res, 409, 'EXAM_NOT_OPEN', err.message);
  const status = err instanceof ContainerError ? USER_FACING[err.code] : undefined;
  if (err instanceof ContainerError && status) return sendError(res, status, err.code, err.message);
  next(err);
}
