import { Router, type Response } from 'express';
import type { AttemptView, ExamResultView } from '@linuxlab/shared';
import { config } from '../config.js';
import { sendError } from '../http/errors.js';
import { rateLimit, type Limiters } from '../http/rateLimit.js';
import { requireSession, sessionOf } from '../http/requireSession.js';
import { requireAllowedOrigin } from '../http/security.js';
import type { AttemptService } from '../modules/attempts/attemptService.js';
import { getExamById } from '../modules/exams/examService.js';
import type { SessionManager } from '../modules/sessions/sessionManager.js';

const QUESTION_ID = /^[A-Za-z0-9_-]{1,100}$/;

export function attemptRouter(sessions: SessionManager, attempts: AttemptService, limiters: Limiters): Router {
  const router = Router();
  const sameOrigin = requireAllowedOrigin(config.security.allowedOrigins);
  const writeLimit = rateLimit(limiters.writes, (_req, res) => sessionOf(res).id, 'Too many requests. Slow down.');

  /** Loads the caller's attempt + exam or sends 404. */
  async function load(res: Response) {
    const attempt = await attempts.get(sessionOf(res).attemptId);
    const exam = attempt && getExamById(attempt.examId);
    if (!attempt || !exam) {
      sendError(res, 404, 'NOT_FOUND', 'Exam attempt not found');
      return undefined;
    }
    return { attempt, exam };
  }

  // GET /api/attempt — live state: timer, current question, progress, score.
  router.get('/attempt', requireSession(sessions), async (_req, res, next) => {
    try {
      const found = await load(res);
      if (!found) return;
      const body: AttemptView = await attempts.view(found.exam, found.attempt);
      res.json(body);
    } catch (err) {
      next(err);
    }
  });

  // PUT /api/attempt/current-question — remember which question is open (for recovery).
  router.put('/attempt/current-question', sameOrigin, requireSession(sessions), writeLimit, async (req, res, next) => {
    try {
      const questionId: unknown = (req.body as { questionId?: unknown } | undefined)?.questionId;
      if (typeof questionId !== 'string' || !QUESTION_ID.test(questionId)) {
        return sendError(res, 400, 'BAD_REQUEST', 'questionId is required');
      }
      const found = await load(res);
      if (!found) return;
      if (!(await attempts.setCurrentQuestion(found.attempt, questionId))) {
        return sendError(res, 404, 'NOT_FOUND', 'No such question');
      }
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // POST /api/attempt/finish — end the exam now; returns the final result.
  router.post('/attempt/finish', sameOrigin, requireSession(sessions), writeLimit, async (_req, res, next) => {
    try {
      const found = await load(res);
      if (!found) return;
      await attempts.complete(found.attempt.id, 'finished');
      const completed = await attempts.get(found.attempt.id);
      const body: ExamResultView = await attempts.result(found.exam, completed ?? found.attempt);
      res.json(body);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/attempt/result — final result, only once the exam is over.
  router.get('/attempt/result', requireSession(sessions), async (_req, res, next) => {
    try {
      const found = await load(res);
      if (!found) return;
      if (found.attempt.status !== 'completed') {
        return sendError(res, 409, 'IN_PROGRESS', 'Results are available after the exam ends');
      }
      const body: ExamResultView = await attempts.result(found.exam, found.attempt);
      res.json(body);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
