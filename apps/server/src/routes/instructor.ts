import { Router, type RequestHandler } from 'express';
import type { AttemptDetail, AttemptSummary, ExamAnalysis, GradingQueue, InstructorStatus } from '@linuxlab/shared';
import { config } from '../config.js';
import { sendError } from '../http/errors.js';
import { INSTRUCTOR_COOKIE, instructorOf, requireInstructor } from '../http/requireInstructor.js';
import { clientAddress } from '../http/rateLimit.js';
import { readCookie, requireAllowedOrigin } from '../http/security.js';
import type { AttemptService } from '../modules/attempts/attemptService.js';
import { FIRST_ADMIN_USERNAME, toMe, type InstructorAuth } from '../modules/instructor/instructorAuth.js';
import { GenerationError } from '../modules/authoring/questionGenerator.js';
import type { InstructorService } from '../modules/instructor/instructorService.js';

const ATTEMPT_ID = /^[0-9a-f-]{36}$/;
const QUESTION_ID = /^[A-Za-z0-9_-]{1,100}$/;
const EXAM_ID = /^[A-Za-z0-9_-]{1,100}$/;

export function instructorRouter(
  auth: InstructorAuth,
  service: InstructorService,
  attempts: AttemptService,
  deleteAttempt: (attemptId: string) => Promise<boolean>,
): Router {
  const router = Router();
  const sameOrigin = requireAllowedOrigin(config.security.allowedOrigins);
  const instructorOnly = requireInstructor(auth);

  /** A professor reaches only their own attempts; anyone else's look like they don't exist. */
  const ownAttempt: RequestHandler = async (req, res, next) => {
    const attemptId = String(req.params.attemptId);
    if (!ATTEMPT_ID.test(attemptId)) return sendError(res, 400, 'BAD_REQUEST', 'Invalid attempt id');
    try {
      const attempt = await attempts.get(attemptId);
      if (attempt?.ownerId !== instructorOf(res).id) return sendError(res, 404, 'NOT_FOUND', 'Attempt not found');
      next();
    } catch (err) {
      next(err);
    }
  };

  router.get('/instructor/me', async (req, res, next) => {
    try {
      const me = await auth.current(readCookie(req.headers.cookie, INSTRUCTOR_COOKIE));
      const body: InstructorStatus = { enabled: auth.enabled, authenticated: Boolean(me), me: me ? toMe(me) : null };
      res.json(body);
    } catch (err) {
      next(err);
    }
  });

  router.post('/instructor/login', sameOrigin, async (req, res, next) => {
    const raw = (req.body ?? {}) as { username?: unknown; password?: unknown };
    const { password } = raw;
    const username = raw.username === undefined ? FIRST_ADMIN_USERNAME : raw.username;
    if (typeof username !== 'string' || username.trim().length === 0 || username.length > 100) {
      return sendError(res, 400, 'BAD_REQUEST', 'Username is required');
    }
    if (typeof password !== 'string' || password.length === 0 || password.length > 200) {
      return sendError(res, 400, 'BAD_REQUEST', 'Password is required');
    }
    let outcome;
    try {
      outcome = await auth.login(username.trim(), password, clientAddress(req));
    } catch (err) {
      return next(err);
    }
    if (!outcome.ok) {
      if (outcome.reason === 'disabled') {
        return sendError(res, 503, 'INSTRUCTOR_DISABLED', 'Instructor access is not configured on this server (INSTRUCTOR_PASSWORD).');
      }
      if (outcome.reason === 'rate-limited') {
        return sendError(res, 429, 'RATE_LIMITED', 'Too many failed attempts. Try again in 15 minutes.');
      }
      return sendError(res, 401, 'INVALID_PASSWORD', 'Incorrect username or password');
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
      const body: AttemptSummary[] = await service.listAttempts(instructorOf(res).id);
      res.json(body);
    } catch (err) {
      next(err);
    }
  });

  router.get('/instructor/attempts/:attemptId', instructorOnly, ownAttempt, async (req, res, next) => {
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

  // POST /api/instructor/attempts/:attemptId/unlock — let a student who left the screen continue.
  router.post('/instructor/attempts/:attemptId/unlock', sameOrigin, instructorOnly, ownAttempt, async (req, res, next) => {
    const attemptId = String(req.params.attemptId);
    if (!ATTEMPT_ID.test(attemptId)) return sendError(res, 400, 'BAD_REQUEST', 'Invalid attempt id');
    try {
      await attempts.unlock(attemptId);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // PUT /api/instructor/attempts/:attemptId/questions/:questionId/grade { correct } — mark a
  // question of a finished attempt correct (true) or not (false); null = automatic grade.
  router.put('/instructor/attempts/:attemptId/questions/:questionId/grade', sameOrigin, instructorOnly, ownAttempt, async (req, res, next) => {
    const attemptId = String(req.params.attemptId);
    const questionId = String(req.params.questionId);
    const { correct, points } = (req.body ?? {}) as { correct?: unknown; points?: unknown };
    const valid = typeof points === 'number' || typeof correct === 'boolean' || correct === null;
    if (!ATTEMPT_ID.test(attemptId) || !QUESTION_ID.test(questionId) || !valid) {
      return sendError(res, 400, 'BAD_REQUEST', 'Send points, or correct as true, false or null');
    }
    try {
      const outcome = await attempts.setGradeOverride(
        attemptId,
        questionId,
        typeof points === 'number' ? { points } : { correct: correct as boolean | null },
      );
      if (outcome === 'invalid-points') return sendError(res, 400, 'INVALID_POINTS', "Points must be between 0 and the question's maximum.");
      if (outcome === 'not-found') return sendError(res, 404, 'NOT_FOUND', 'Attempt or question not found');
      if (outcome === 'in-progress') return sendError(res, 409, 'IN_PROGRESS', 'Grades can be changed after the student finishes.');
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // GET /api/instructor/exams/:examId/analysis — how each question went. Only this
  // professor's attempts are counted, so anyone else's test simply comes back empty.
  router.get('/instructor/exams/:examId/analysis', instructorOnly, async (req, res, next) => {
    const examId = String(req.params.examId);
    if (!EXAM_ID.test(examId)) return sendError(res, 400, 'BAD_REQUEST', 'Invalid exam id');
    try {
      const body: ExamAnalysis = await service.examAnalysis(examId, instructorOf(res).id);
      res.json(body);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/instructor/exams/:examId/grading — this professor's short answers on a test.
  router.get('/instructor/exams/:examId/grading', instructorOnly, async (req, res, next) => {
    const examId = String(req.params.examId);
    if (!EXAM_ID.test(examId)) return sendError(res, 400, 'BAD_REQUEST', 'Invalid exam id');
    try {
      const body: GradingQueue = await service.gradingQueue(examId, instructorOf(res).id);
      res.json(body);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/instructor/exams/:examId/questions/:questionId/suggest-grades — AI suggestions.
  router.post('/instructor/exams/:examId/questions/:questionId/suggest-grades', sameOrigin, instructorOnly, async (req, res, next) => {
    const examId = String(req.params.examId);
    const questionId = String(req.params.questionId);
    if (!EXAM_ID.test(examId) || !QUESTION_ID.test(questionId)) return sendError(res, 400, 'BAD_REQUEST', 'Invalid id');
    try {
      const outcome = await service.suggestGrades(examId, questionId, instructorOf(res).id);
      if (outcome === 'disabled') return sendError(res, 503, 'AI_DISABLED', 'AI grading is not set up: add OPENAI_API_KEY to the .env file.');
      if (outcome === 'busy') return sendError(res, 429, 'BUSY', 'AI is already grading. Please wait for it to finish.');
      if (outcome === 'not-found') return sendError(res, 404, 'NOT_FOUND', 'No short answers found for that question.');
      res.json(outcome);
    } catch (err) {
      if (err instanceof GenerationError) return sendError(res, 502, 'AI_FAILED', err.message);
      next(err);
    }
  });

  // DELETE /api/instructor/attempts/:attemptId — remove an attempt and all its records.
  router.delete('/instructor/attempts/:attemptId', sameOrigin, instructorOnly, ownAttempt, async (req, res, next) => {
    const attemptId = String(req.params.attemptId);
    if (!ATTEMPT_ID.test(attemptId)) return sendError(res, 400, 'BAD_REQUEST', 'Invalid attempt id');
    try {
      if (!(await deleteAttempt(attemptId))) return sendError(res, 404, 'NOT_FOUND', 'Attempt not found');
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
