import { Router } from 'express';
import type { StudentExam } from '@linuxlab/shared';
import { config } from '../config.js';
import { sendError } from '../http/errors.js';
import { rateLimit, type Limiters } from '../http/rateLimit.js';
import { requireSession, sessionOf } from '../http/requireSession.js';
import { requireAllowedOrigin } from '../http/security.js';
import type { AttemptService } from '../modules/attempts/attemptService.js';
import type { ContainerRuntime } from '../modules/containers/index.js';
import { examForAttempt, toStudentExam } from '../modules/exams/examService.js';
import { submitAnswer } from '../modules/exams/submitAnswer.js';
import type { SessionManager } from '../modules/sessions/sessionManager.js';

const QUESTION_ID = /^[A-Za-z0-9_-]{1,100}$/;

const BLOCK_MESSAGES = {
  completed: 'This exam has ended; no more answers can be submitted.',
  locked: 'This question has already been submitted and is locked.',
  'no-attempts-left': 'You have used all attempts for this question.',
  'test-locked': 'Your test is locked because you left the test screen. Please call your instructor.',
} as const;

export interface ExamRouteDeps {
  sessions: SessionManager;
  attempts: AttemptService;
  runtime: ContainerRuntime;
  limiters: Limiters;
}

export function examRouter({ sessions, attempts, runtime, limiters }: ExamRouteDeps): Router {
  const router = Router();
  const sameOrigin = requireAllowedOrigin(config.security.allowedOrigins);
  const submitLimit = rateLimit(limiters.submits, (_req, res) => sessionOf(res).id, 'Too many submissions. Wait a moment and try again.');

  // GET /api/exam — the exam this student is taking, without validators or answers.
  router.get('/exam', requireSession(sessions), async (_req, res, next) => {
    try {
      const attempt = await attempts.get(sessionOf(res).attemptId);
      const exam = attempt && examForAttempt(attempt);
      if (!exam) return sendError(res, 404, 'NOT_FOUND', 'Exam not found');
      const body: StudentExam = toStudentExam(exam);
      res.json(body);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/exam/questions/:questionId/submit — grade the container's current state.
  router.post('/exam/questions/:questionId/submit', sameOrigin, requireSession(sessions), submitLimit, async (req, res, next) => {
    const questionId = String(req.params.questionId);
    if (!QUESTION_ID.test(questionId)) return sendError(res, 400, 'BAD_REQUEST', 'Invalid question id');
    try {
      const outcome = await submitAnswer({ runtime, attempts, examFor: examForAttempt }, sessionOf(res), questionId);
      switch (outcome.kind) {
        case 'graded':
          res.json(outcome.result);
          return;
        case 'unknown-question':
          return sendError(res, 404, 'NOT_FOUND', 'No such question');
        case 'busy':
          return sendError(res, 429, 'BUSY', 'Your previous answer is still being checked');
        case 'blocked':
          return sendError(res, 409, outcome.reason.toUpperCase().replace(/-/g, '_'), BLOCK_MESSAGES[outcome.reason]);
        case 'environment-ended':
          return sendError(res, 409, 'ENVIRONMENT_ENDED', 'Your Linux environment has ended. Refresh the page.');
      }
    } catch (err) {
      next(err);
    }
  });

  return router;
}
