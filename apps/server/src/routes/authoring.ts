import { Router, type NextFunction, type Request, type Response } from 'express';
import { config } from '../config.js';
import { sendError } from '../http/errors.js';
import { requireInstructor } from '../http/requireInstructor.js';
import { requireAllowedOrigin } from '../http/security.js';
import { AuthoringError, type AuthoringService } from '../modules/authoring/authoringService.js';
import type { InstructorAuth } from '../modules/instructor/instructorAuth.js';

const ID = /^[A-Za-z0-9_-]{1,100}$/;

/** Instructor exam editor API. Every route requires an instructor session. */
export function authoringRouter(auth: InstructorAuth, authoring: AuthoringService): Router {
  const router = Router();
  const instructorOnly = requireInstructor(auth);
  const write = [requireAllowedOrigin(config.security.allowedOrigins), instructorOnly];

  /** Runs a handler with id checks and uniform error handling. */
  const handle =
    (fn: (req: Request, res: Response) => Promise<unknown> | unknown, status = 200) =>
    async (req: Request, res: Response, next: NextFunction) => {
      for (const key of ['examId', 'questionId'] as const) {
        const v = req.params[key];
        if (v !== undefined && !ID.test(String(v))) return sendError(res, 400, 'BAD_REQUEST', 'Invalid id');
      }
      try {
        const body = await fn(req, res);
        if (status === 204) res.status(204).end();
        else res.status(status).json(body);
      } catch (err) {
        if (err instanceof AuthoringError) return sendError(res, err.status, 'AUTHORING', err.message);
        next(err);
      }
    };

  const p = (req: Request, key: string) => String(req.params[key]);

  router.get('/instructor/ai', instructorOnly, handle(() => authoring.aiStatus()));
  router.post('/instructor/exams/:examId/generate', ...write, handle((req) => authoring.generate(p(req, 'examId'), req.body)));

  router.get('/instructor/exams', instructorOnly, handle(() => authoring.listExams()));
  router.post('/instructor/exams', ...write, handle((req) => authoring.createExam((req.body as { title?: unknown })?.title), 201));
  router.get('/instructor/exams/:examId', instructorOnly, handle((req) => authoring.examDetail(p(req, 'examId'))));
  router.put('/instructor/exams/:examId', ...write, handle((req) => authoring.updateExam(p(req, 'examId'), req.body)));
  router.delete('/instructor/exams/:examId', ...write, handle((req) => authoring.deleteExam(p(req, 'examId')), 204));
  router.post('/instructor/exams/:examId/enable', ...write, handle((req) => authoring.setEnabled(p(req, 'examId'), true)));
  router.post('/instructor/exams/:examId/disable', ...write, handle((req) => authoring.setEnabled(p(req, 'examId'), false)));
  router.put(
    '/instructor/exams/:examId/order',
    ...write,
    handle((req) => authoring.reorder(p(req, 'examId'), (req.body as { order?: unknown })?.order)),
  );

  router.post('/instructor/exams/:examId/questions', ...write, handle((req) => authoring.addQuestion(p(req, 'examId'), req.body), 201));
  router.put(
    '/instructor/exams/:examId/questions/:questionId',
    ...write,
    handle((req) => authoring.updateQuestion(p(req, 'examId'), p(req, 'questionId'), req.body)),
  );
  router.delete(
    '/instructor/exams/:examId/questions/:questionId',
    ...write,
    handle((req) => authoring.deleteQuestion(p(req, 'examId'), p(req, 'questionId')), 204),
  );
  router.post(
    '/instructor/exams/:examId/questions/:questionId/approve',
    ...write,
    handle((req) => authoring.approve(p(req, 'examId'), p(req, 'questionId'))),
  );
  router.post(
    '/instructor/exams/:examId/questions/:questionId/unapprove',
    ...write,
    handle((req) => authoring.unapprove(p(req, 'examId'), p(req, 'questionId'))),
  );
  router.post(
    '/instructor/exams/:examId/questions/:questionId/test',
    ...write,
    handle((req) => authoring.retest(p(req, 'examId'), p(req, 'questionId')), 204),
  );

  return router;
}
