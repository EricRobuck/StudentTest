import type { SubmitResult } from '@linuxlab/shared';
import type { ContainerRuntime } from '../containers/index.js';
import { gradeQuestion } from '../grading/index.js';
import type { ExamSession } from '../sessions/sessionManager.js';
import type { ExamDefinition } from './types.js';

export type SubmitOutcome =
  | { kind: 'graded'; result: SubmitResult }
  | { kind: 'unknown-question' }
  | { kind: 'busy' }
  | { kind: 'environment-ended' };

// One grading run at a time per session: repeated clicks can't pile up
// commands inside the student's container.
const gradingInProgress = new Set<string>();

/**
 * Grades the current state of the student's container against one question.
 * Phase 7 adds attempt limits, locking, and saving the score.
 */
export async function submitAnswer(
  runtime: ContainerRuntime,
  exam: ExamDefinition,
  session: ExamSession,
  questionId: string,
): Promise<SubmitOutcome> {
  const question = exam.questions.find((q) => q.id === questionId);
  if (!question) return { kind: 'unknown-question' };
  if (gradingInProgress.has(session.id)) return { kind: 'busy' };

  gradingInProgress.add(session.id);
  try {
    if (!(await runtime.isRunning(session.containerId))) return { kind: 'environment-ended' };

    const grade = await gradeQuestion({ runtime, containerId: session.containerId }, question.validation);
    const result: SubmitResult = {
      questionId: question.id,
      passed: grade.passed,
      pointsAwarded: Math.round(question.points * grade.score * 100) / 100,
      maxPoints: question.points,
      // Only student-facing fields leave the server; `detail` stays here.
      rules: grade.rules.map((r) => ({ passed: r.passed, message: r.message })),
      gradedAt: new Date().toISOString(),
    };

    console.log(
      `[grading] session ${session.id} ${question.id}: ${grade.passed ? 'PASS' : 'FAIL'} ` +
        grade.rules.map((r) => `[${r.type} ${r.passed ? 'ok' : 'x'} ${r.detail ?? ''}]`).join(' '),
    );
    return { kind: 'graded', result };
  } finally {
    gradingInProgress.delete(session.id);
  }
}
