import { Router } from 'express';
import type { StudentExam } from '@linuxlab/shared';
import { requireSession } from '../http/requireSession.js';
import { getActiveExam, toStudentExam } from '../modules/exams/examService.js';
import type { SessionManager } from '../modules/sessions/sessionManager.js';

export function examRouter(sessions: SessionManager): Router {
  const router = Router();

  // GET /api/exam — the student's exam, without validators or answers.
  router.get('/exam', requireSession(sessions), (_req, res) => {
    const body: StudentExam = toStudentExam(getActiveExam());
    res.json(body);
  });

  return router;
}
