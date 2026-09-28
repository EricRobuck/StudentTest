import { Router, type Response } from 'express';
import type { ApiError, StudentExam } from '@linuxlab/shared';
import { config } from '../config.js';
import { requireSession, sessionOf } from '../http/requireSession.js';
import { requireAllowedOrigin } from '../http/security.js';
import type { ContainerRuntime } from '../modules/containers/index.js';
import { getActiveExam, toStudentExam } from '../modules/exams/examService.js';
import { submitAnswer } from '../modules/exams/submitAnswer.js';
import type { SessionManager } from '../modules/sessions/sessionManager.js';

const QUESTION_ID = /^[A-Za-z0-9_-]{1,100}$/;

export function examRouter(sessions: SessionManager, runtime: ContainerRuntime): Router {
  const router = Router();

  // GET /api/exam — the student's exam, without validators or answers.
  router.get('/exam', requireSession(sessions), (_req, res) => {
    const body: StudentExam = toStudentExam(getActiveExam());
    res.json(body);
  });

  // POST /api/exam/questions/:questionId/submit — grade the container's current state.
  router.post(
    '/exam/questions/:questionId/submit',
    requireAllowedOrigin(config.security.allowedOrigins),
    requireSession(sessions),
    async (req, res, next) => {
      const questionId = String(req.params.questionId);
      if (!QUESTION_ID.test(questionId)) return sendError(res, 400, 'BAD_REQUEST', 'Invalid question id');
      try {
        const outcome = await submitAnswer(runtime, getActiveExam(), sessionOf(res), questionId);
        switch (outcome.kind) {
          case 'graded':
            res.json(outcome.result);
            return;
          case 'unknown-question':
            return sendError(res, 404, 'NOT_FOUND', 'No such question');
          case 'busy':
            return sendError(res, 429, 'BUSY', 'Your previous answer is still being checked');
          case 'environment-ended':
            return sendError(res, 409, 'ENVIRONMENT_ENDED', 'Your Linux environment has ended. Refresh the page.');
        }
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}

function sendError(res: Response, status: number, code: string, message: string): void {
  const body: ApiError = { error: { code, message } };
  res.status(status).json(body);
}
