import { randomUUID } from 'node:crypto';
import type {
  AttemptEndReason,
  AttemptView,
  ExamResultView,
  QuestionProgress,
  ScoreView,
} from '@linuxlab/shared';
import type { AttemptRecord, Repositories, SubmissionRecord } from '../db/index.js';
import { orderedQuestions } from '../exams/examService.js';
import type { ExamDefinition } from '../exams/types.js';

// Scoring rules (one place, used by every endpoint):
//  - A question's points are its BEST submission. State-based questions can
//    be undone by later tasks (cd away from /etc, overwrite a file), so a
//    later failed re-check never takes points away.
//  - The exam score is the sum of those points.
//  - Deadlines use the server clock only.

export type SubmitBlock = 'completed' | 'locked' | 'no-attempts-left';

export class AttemptService {
  private readonly completedListeners: Array<(attemptId: string) => void> = [];

  constructor(
    private readonly repos: Repositories,
    private readonly examById: (id: string) => ExamDefinition | undefined,
  ) {}

  /** Called when an attempt completes (finish button or time expiry). */
  onCompleted(listener: (attemptId: string) => void): void {
    this.completedListeners.push(listener);
  }

  async start(exam: ExamDefinition, now = new Date()): Promise<AttemptRecord> {
    const questions = orderedQuestions(exam);
    const limit = exam.settings.timeLimitMinutes;
    const attempt: AttemptRecord = {
      id: randomUUID(),
      examId: exam.id,
      studentId: null,
      status: 'in_progress',
      endReason: null,
      startedAt: now.toISOString(),
      deadlineAt: limit === null ? null : new Date(now.getTime() + limit * 60_000).toISOString(),
      completedAt: null,
      currentQuestionId: questions[0]?.id ?? null,
    };
    await this.repos.attempts.create(
      attempt,
      questions.map((q, i) => ({ questionId: q.id, position: i + 1, maxPoints: q.points, variables: {} })),
    );
    return attempt;
  }

  /** Loads an attempt, first completing it if its time has run out. */
  async get(attemptId: string): Promise<AttemptRecord | undefined> {
    const attempt = await this.repos.attempts.get(attemptId);
    if (attempt && isOverdue(attempt)) {
      await this.complete(attempt.id, 'time_expired');
      return this.repos.attempts.get(attemptId);
    }
    return attempt;
  }

  async complete(attemptId: string, reason: AttemptEndReason): Promise<boolean> {
    const changed = await this.repos.attempts.complete(attemptId, reason, new Date().toISOString());
    if (changed) {
      console.log(`[attempts] attempt ${attemptId} completed (${reason})`);
      for (const listener of this.completedListeners) listener(attemptId);
    }
    return changed;
  }

  /** Completes every attempt whose deadline has passed. Run periodically. */
  async expireOverdue(): Promise<void> {
    for (const a of await this.repos.attempts.listExpired(new Date().toISOString())) {
      await this.complete(a.id, 'time_expired');
    }
  }

  async setCurrentQuestion(attempt: AttemptRecord, questionId: string): Promise<boolean> {
    const exam = this.examById(attempt.examId);
    if (!exam?.questions.some((q) => q.id === questionId)) return false;
    await this.repos.attempts.setCurrentQuestion(attempt.id, questionId);
    return true;
  }

  submissions(attemptId: string): Promise<SubmissionRecord[]> {
    return this.repos.submissions.listForAttempt(attemptId);
  }

  /** Why a submission for this question would be refused, or null if allowed. */
  submitBlock(exam: ExamDefinition, attempt: AttemptRecord, questionId: string, subs: SubmissionRecord[]): SubmitBlock | null {
    if (attempt.status !== 'in_progress') return 'completed';
    const count = subs.filter((s) => s.questionId === questionId).length;
    if (exam.settings.lockAfterSubmit && count > 0) return 'locked';
    const max = exam.settings.maxAttemptsPerQuestion;
    if (max !== null && count >= max) return 'no-attempts-left';
    return null;
  }

  async recordSubmission(
    attempt: AttemptRecord,
    questionId: string,
    grade: { passed: boolean; score: number; pointsAwarded: number; maxPoints: number; ruleResults: unknown },
  ): Promise<number> {
    return this.repos.submissions.add({
      id: randomUUID(),
      attemptId: attempt.id,
      questionId,
      passed: grade.passed,
      score: grade.score,
      pointsAwarded: grade.pointsAwarded,
      maxPoints: grade.maxPoints,
      ruleResults: grade.ruleResults,
      submittedAt: new Date().toISOString(),
    });
  }

  progress(exam: ExamDefinition, attempt: AttemptRecord, subs: SubmissionRecord[], questionId: string): QuestionProgress {
    const mine = subs.filter((s) => s.questionId === questionId);
    const max = exam.settings.maxAttemptsPerQuestion;
    const best = bestOf(mine);
    const revealed = exam.settings.showFeedback || attempt.status === 'completed';
    return {
      questionId,
      attempts: mine.length,
      attemptsRemaining: max === null ? null : Math.max(0, max - mine.length),
      locked: this.submitBlock(exam, attempt, questionId, subs) !== null,
      best: best && revealed ? { passed: best.passed, pointsAwarded: best.pointsAwarded } : null,
    };
  }

  score(exam: ExamDefinition, subs: SubmissionRecord[]): ScoreView {
    const questions = orderedQuestions(exam);
    return {
      earned: round2(questions.reduce((sum, q) => sum + (bestOf(subs.filter((s) => s.questionId === q.id))?.pointsAwarded ?? 0), 0)),
      max: questions.reduce((sum, q) => sum + q.points, 0),
    };
  }

  /** The student's view of their attempt; hides what the exam settings hide. */
  async view(exam: ExamDefinition, attempt: AttemptRecord): Promise<AttemptView> {
    const subs = await this.submissions(attempt.id);
    const scoreVisible = exam.settings.showScoreDuringExam || attempt.status === 'completed';
    return {
      id: attempt.id,
      status: attempt.status,
      startedAt: attempt.startedAt,
      deadlineAt: attempt.deadlineAt,
      serverTime: new Date().toISOString(),
      currentQuestionId: attempt.currentQuestionId,
      score: scoreVisible ? this.score(exam, subs) : null,
      questions: orderedQuestions(exam).map((q) => this.progress(exam, attempt, subs, q.id)),
    };
  }

  /** Final results. Only valid for completed attempts. */
  async result(exam: ExamDefinition, attempt: AttemptRecord): Promise<ExamResultView> {
    const subs = await this.submissions(attempt.id);
    const score = this.score(exam, subs);
    return {
      examTitle: exam.title,
      startedAt: attempt.startedAt,
      completedAt: attempt.completedAt ?? new Date().toISOString(),
      endReason: attempt.endReason ?? 'finished',
      score,
      percentage: score.max === 0 ? 0 : Math.round((score.earned / score.max) * 1000) / 10,
      questions: orderedQuestions(exam).map((q, i) => {
        const mine = subs.filter((s) => s.questionId === q.id);
        const best = bestOf(mine);
        return {
          questionId: q.id,
          number: i + 1,
          title: q.title,
          pointsAwarded: best?.pointsAwarded ?? 0,
          maxPoints: q.points,
          passed: best?.passed ?? false,
          attempts: mine.length,
        };
      }),
    };
  }
}

function bestOf(subs: SubmissionRecord[]): SubmissionRecord | undefined {
  let best: SubmissionRecord | undefined;
  for (const s of subs) if (!best || s.pointsAwarded > best.pointsAwarded) best = s;
  return best;
}

function isOverdue(a: AttemptRecord): boolean {
  return a.status === 'in_progress' && a.deadlineAt !== null && Date.parse(a.deadlineAt) <= Date.now();
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
