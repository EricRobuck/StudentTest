import type { AttemptEndReason, AttemptStatus } from '@linuxlab/shared';
import { inTransaction, type Database } from './database.js';
import type {
  AttemptQuestionRecord,
  AttemptRecord,
  Repositories,
  SessionRecord,
  SubmissionRecord,
} from './repositories.js';

type Row = Record<string, unknown>;

const str = (v: unknown): string => String(v);
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function toAttempt(r: Row): AttemptRecord {
  return {
    id: str(r.id),
    examId: str(r.exam_id),
    studentId: strOrNull(r.student_id),
    status: str(r.status) as AttemptStatus,
    endReason: strOrNull(r.end_reason) as AttemptEndReason | null,
    startedAt: str(r.started_at),
    deadlineAt: strOrNull(r.deadline_at),
    completedAt: strOrNull(r.completed_at),
    currentQuestionId: strOrNull(r.current_question_id),
  };
}

function toSession(r: Row): SessionRecord {
  return {
    id: str(r.id),
    tokenHash: str(r.token_hash),
    attemptId: str(r.attempt_id),
    containerId: strOrNull(r.container_id),
    containerName: strOrNull(r.container_name),
    createdAt: str(r.created_at),
    lastActiveAt: str(r.last_active_at),
  };
}

function toSubmission(r: Row): SubmissionRecord {
  return {
    id: str(r.id),
    attemptId: str(r.attempt_id),
    questionId: str(r.question_id),
    attemptNumber: Number(r.attempt_number),
    passed: Number(r.passed) === 1,
    score: Number(r.score),
    pointsAwarded: Number(r.points_awarded),
    maxPoints: Number(r.max_points),
    ruleResults: JSON.parse(str(r.rule_results)) as unknown,
    submittedAt: str(r.submitted_at),
  };
}

export function createSqliteRepositories(db: Database): Repositories {
  return {
    attempts: {
      async create(a, questions) {
        inTransaction(db, () => {
          db.prepare(
            `INSERT INTO exam_attempts (id, exam_id, student_id, status, end_reason, started_at,
               deadline_at, completed_at, current_question_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(a.id, a.examId, a.studentId, a.status, a.endReason, a.startedAt, a.deadlineAt, a.completedAt, a.currentQuestionId);
          const insertQuestion = db.prepare(
            `INSERT INTO attempt_questions (attempt_id, question_id, position, max_points, variables)
             VALUES (?, ?, ?, ?, ?)`,
          );
          for (const q of questions) {
            insertQuestion.run(a.id, q.questionId, q.position, q.maxPoints, JSON.stringify(q.variables));
          }
        });
      },
      async get(id) {
        const row = db.prepare('SELECT * FROM exam_attempts WHERE id = ?').get(id);
        return row ? toAttempt(row) : undefined;
      },
      async questions(attemptId) {
        return db
          .prepare('SELECT * FROM attempt_questions WHERE attempt_id = ? ORDER BY position')
          .all(attemptId)
          .map(
            (r): AttemptQuestionRecord => ({
              questionId: str(r.question_id),
              position: Number(r.position),
              maxPoints: Number(r.max_points),
              variables: JSON.parse(str(r.variables)) as Record<string, string>,
            }),
          );
      },
      async setCurrentQuestion(id, questionId) {
        db.prepare('UPDATE exam_attempts SET current_question_id = ? WHERE id = ?').run(questionId, id);
      },
      async complete(id, reason, completedAt) {
        const result = db
          .prepare(
            `UPDATE exam_attempts SET status = 'completed', end_reason = ?, completed_at = ?
             WHERE id = ? AND status = 'in_progress'`,
          )
          .run(reason, completedAt, id);
        return Number(result.changes) > 0;
      },
      async listExpired(now) {
        return db
          .prepare(
            `SELECT * FROM exam_attempts
             WHERE status = 'in_progress' AND deadline_at IS NOT NULL AND deadline_at <= ?`,
          )
          .all(now)
          .map(toAttempt);
      },
    },

    sessions: {
      async create(s) {
        db.prepare(
          `INSERT INTO sessions (id, token_hash, attempt_id, container_id, container_name, created_at, last_active_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(s.id, s.tokenHash, s.attemptId, s.containerId, s.containerName, s.createdAt, s.lastActiveAt);
      },
      async findByTokenHash(tokenHash) {
        const row = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(tokenHash);
        return row ? toSession(row) : undefined;
      },
      async get(id) {
        const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
        return row ? toSession(row) : undefined;
      },
      async findByAttempt(attemptId) {
        return db.prepare('SELECT * FROM sessions WHERE attempt_id = ?').all(attemptId).map(toSession);
      },
      async setContainer(id, containerId, containerName) {
        db.prepare('UPDATE sessions SET container_id = ?, container_name = ? WHERE id = ?').run(
          containerId,
          containerName,
          id,
        );
      },
      async touch(id, at) {
        db.prepare('UPDATE sessions SET last_active_at = ? WHERE id = ?').run(at, id);
      },
      async listWithContainer() {
        return db.prepare('SELECT * FROM sessions WHERE container_id IS NOT NULL').all().map(toSession);
      },
    },

    submissions: {
      async add(s) {
        return inTransaction(db, () => {
          const row = db
            .prepare(
              `SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next
               FROM submissions WHERE attempt_id = ? AND question_id = ?`,
            )
            .get(s.attemptId, s.questionId);
          const attemptNumber = Number(row?.next ?? 1);
          db.prepare(
            `INSERT INTO submissions (id, attempt_id, question_id, attempt_number, passed, score,
               points_awarded, max_points, rule_results, submitted_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            s.id,
            s.attemptId,
            s.questionId,
            attemptNumber,
            s.passed ? 1 : 0,
            s.score,
            s.pointsAwarded,
            s.maxPoints,
            JSON.stringify(s.ruleResults),
            s.submittedAt,
          );
          return attemptNumber;
        });
      },
      async listForAttempt(attemptId) {
        return db
          .prepare('SELECT * FROM submissions WHERE attempt_id = ? ORDER BY submitted_at, attempt_number')
          .all(attemptId)
          .map(toSubmission);
      },
    },
  };
}
