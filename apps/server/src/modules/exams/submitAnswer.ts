import type { SubmitResult } from '@linuxlab/shared';
import type { AttemptService, SubmitBlock } from '../attempts/attemptService.js';
import type { ContainerRuntime } from '../containers/index.js';
import { gradeQuestion } from '../grading/index.js';
import type { ExamSession } from '../sessions/sessionManager.js';
import type { ExamDefinition } from './types.js';

export type SubmitOutcome =
  | { kind: 'graded'; result: SubmitResult }
  | { kind: 'unknown-question' }
  | { kind: 'busy' }
  | { kind: 'blocked'; reason: SubmitBlock }
  | { kind: 'environment-ended' };

export interface SubmitDeps {
  runtime: ContainerRuntime;
  attempts: AttemptService;
  examById: (id: string) => ExamDefinition | undefined;
}

// One grading run at a time per session: repeated clicks can't pile up
// commands inside the student's container.
const gradingInProgress = new Set<string>();

/**
 * Grades the current state of the student's container against one question
 * and records the submission. Every exam rule (time, attempt limits, locks)
 * is enforced here, server-side.
 */
export async function submitAnswer(deps: SubmitDeps, session: ExamSession, questionId: string): Promise<SubmitOutcome> {
  if (gradingInProgress.has(session.id)) return { kind: 'busy' };
  gradingInProgress.add(session.id);
  try {
    // get() also completes the attempt if its time is up.
    const attempt = await deps.attempts.get(session.attemptId);
    const exam = attempt && deps.examById(attempt.examId);
    if (!attempt || !exam) return { kind: 'blocked', reason: 'completed' };
    const question = exam.questions.find((q) => q.id === questionId);
    if (!question) return { kind: 'unknown-question' };

    const before = await deps.attempts.submissions(attempt.id);
    const block = deps.attempts.submitBlock(exam, attempt, questionId, before);
    if (block) return { kind: 'blocked', reason: block };

    if (!session.containerId || !(await deps.runtime.isRunning(session.containerId))) {
      return { kind: 'environment-ended' };
    }

    const grade = await gradeQuestion({ runtime: deps.runtime, containerId: session.containerId }, question.validation);
    const pointsAwarded = Math.round(question.points * grade.score * 100) / 100;
    const attemptNumber = await deps.attempts.recordSubmission(attempt, question.id, {
      passed: grade.passed,
      score: grade.score,
      pointsAwarded,
      maxPoints: question.points,
      ruleResults: grade.rules, // full detail kept for instructors
    });
    console.log(
      `[grading] attempt ${attempt.id} ${question.id} #${attemptNumber}: ${grade.passed ? 'PASS' : 'FAIL'} ` +
        // detail can hold student-controlled text: JSON-quote it so it can't forge log lines.
        grade.rules.map((r) => `[${r.type} ${r.passed ? 'ok' : 'x'} ${JSON.stringify(r.detail ?? '')}]`).join(' '),
    );

    const after = await deps.attempts.submissions(attempt.id);
    const view = await deps.attempts.view(exam, attempt);
    const result: SubmitResult = {
      questionId: question.id,
      attemptNumber,
      feedback: exam.settings.showFeedback
        ? {
            passed: grade.passed,
            pointsAwarded,
            maxPoints: question.points,
            // Only student-facing fields leave the server; `detail` stays here.
            rules: grade.rules.map((r) => ({ passed: r.passed, message: r.message })),
          }
        : null,
      progress: deps.attempts.progress(exam, attempt, after, question.id),
      score: view.score,
    };
    return { kind: 'graded', result };
  } finally {
    gradingInProgress.delete(session.id);
  }
}
