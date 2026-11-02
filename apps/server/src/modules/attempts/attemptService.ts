import { randomUUID } from 'node:crypto';
import {
  AUTHORING_LIMITS,
  effectiveMaxAttempts,
  isAnswerCorrect,
  isWrittenExam,
  type AttemptEndReason,
  type AttemptView,
  type ExamResultView,
  type QuestionProgress,
  type ScoreView,
  type StudentInfo,
} from '@linuxlab/shared';
import type { AttemptRecord, Repositories, SubmissionRecord } from '../db/index.js';
import { orderedQuestions } from '../exams/examService.js';
import type { ExamDefinition } from '../exams/types.js';

// Scoring rules (one place, used by every endpoint):
//  - A question's points are its BEST submission. State-based questions can
//    be undone by later tasks (cd away from /etc, overwrite a file), so a
//    later failed re-check never takes points away.
//  - The exam score is the sum of those points.
//  - Written questions are graded from the student's current answer.
//  - A question the instructor marked by hand is correct (full points) or not
//    correct (0), whatever automatic grading says.
//  - Deadlines use the server clock only.

/** 'locked' = question locked after submit; 'test-locked' = student left the screen. */
export type SubmitBlock = 'completed' | 'locked' | 'no-attempts-left' | 'test-locked';

/** Everything a student has done on an attempt that counts towards the grade. */
export interface AttemptWork {
  submissions: SubmissionRecord[];
  answers: Map<string, string>;
  overrides: Map<string, boolean>;
}

export type SaveAnswerOutcome =
  | { ok: true; progress: QuestionProgress }
  | { ok: false; reason: 'unknown-question' | 'invalid' | 'completed' | 'test-locked' };

export class AttemptService {
  private readonly completedListeners: Array<(attemptId: string) => void> = [];

  constructor(
    private readonly repos: Repositories,
    private readonly examFor: (attempt: AttemptRecord) => ExamDefinition | undefined,
  ) {}

  /** Called when an attempt completes (finish button or time expiry). */
  onCompleted(listener: (attemptId: string) => void): void {
    this.completedListeners.push(listener);
  }

  async start(exam: ExamDefinition, student: StudentInfo, now = new Date()): Promise<AttemptRecord> {
    const questions = orderedQuestions(exam);
    const limit = exam.settings.timeLimitMinutes;
    const attempt: AttemptRecord = {
      id: randomUUID(),
      examId: exam.id,
      studentId: null,
      studentName: student.name,
      className: student.className,
      status: 'in_progress',
      endReason: null,
      startedAt: now.toISOString(),
      deadlineAt: limit === null ? null : new Date(now.getTime() + limit * 60_000).toISOString(),
      completedAt: null,
      currentQuestionId: questions[0]?.id ?? null,
      // Frozen copy: later edits to the exam never change this attempt.
      examSnapshot: exam,
      lockedAt: null,
      lockReason: null,
    };
    await this.repos.attempts.create(
      attempt,
      questions.map((q, i) => ({ questionId: q.id, position: i + 1, maxPoints: q.points, variables: {} })),
    );
    if (attempt.currentQuestionId) {
      await this.repos.attempts.addVisit(attempt.id, attempt.currentQuestionId, attempt.startedAt);
    }
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

  /**
   * The student left the test screen. Locks the attempt if its test uses
   * "lock on leave"; the instructor must unlock it. Returns true if the
   * attempt is locked afterwards.
   */
  async reportLeft(attempt: AttemptRecord, reason: string): Promise<boolean> {
    const exam = this.examFor(attempt);
    if (attempt.status !== 'in_progress' || !exam || exam.settings.lockOnLeave === false) return false;
    if (attempt.lockedAt) return true;
    const newly = await this.repos.attempts.lock(attempt.id, reason, new Date().toISOString());
    if (newly) {
      console.log(`[integrity] attempt ${attempt.id} (${attempt.studentName ?? 'unnamed'}) LOCKED: ${JSON.stringify(reason)}`);
      for (const listener of this.lockedListeners) listener(attempt.id);
    }
    return true;
  }

  /** Called when an attempt gets locked (e.g. to close the student's terminal). */
  onLocked(listener: (attemptId: string) => void): void {
    this.lockedListeners.push(listener);
  }

  private readonly lockedListeners: Array<(attemptId: string) => void> = [];

  /** Instructor unlocks a locked attempt. */
  async unlock(attemptId: string): Promise<boolean> {
    const unlocked = await this.repos.attempts.unlock(attemptId, 'unlocked by instructor', new Date().toISOString());
    if (unlocked) console.log(`[integrity] attempt ${attemptId} unlocked by instructor`);
    return unlocked;
  }

  async setCurrentQuestion(attempt: AttemptRecord, questionId: string): Promise<boolean> {
    const exam = this.examFor(attempt);
    if (!exam?.questions.some((q) => q.id === questionId)) return false;
    if (attempt.status !== 'in_progress' || attempt.currentQuestionId === questionId) return true;
    await this.repos.attempts.setCurrentQuestion(attempt.id, questionId);
    await this.repos.attempts.addVisit(attempt.id, questionId, new Date().toISOString());
    return true;
  }

  submissions(attemptId: string): Promise<SubmissionRecord[]> {
    return this.repos.submissions.listForAttempt(attemptId);
  }

  async work(attemptId: string): Promise<AttemptWork> {
    const [submissions, answers, overrides] = await Promise.all([
      this.repos.submissions.listForAttempt(attemptId),
      this.repos.attempts.answers(attemptId),
      this.repos.attempts.overrides(attemptId),
    ]);
    return {
      submissions,
      answers: new Map(answers.map((a) => [a.questionId, a.answer])),
      overrides: new Map(overrides.map((o) => [o.questionId, o.correct])),
    };
  }

  /** Saves a student's answer to a written question (changeable until the test ends). */
  async saveWrittenAnswer(exam: ExamDefinition, attempt: AttemptRecord, questionId: string, raw: string): Promise<SaveAnswerOutcome> {
    const question = exam.questions.find((q) => q.id === questionId);
    if (!question?.answer) return { ok: false, reason: 'unknown-question' };
    if (attempt.status !== 'in_progress') return { ok: false, reason: 'completed' };
    if (attempt.lockedAt) return { ok: false, reason: 'test-locked' };
    const answer = raw.trim();
    if (answer.length > AUTHORING_LIMITS.answerMax) return { ok: false, reason: 'invalid' };
    if (answer && question.answer.type === 'multiple_choice') {
      const inRange = /^\d{1,2}$/.test(answer) && Number(answer) < question.answer.choices.length;
      if (!inRange) return { ok: false, reason: 'invalid' };
    }
    await this.repos.attempts.saveAnswer(attempt.id, questionId, answer || null, new Date().toISOString());
    return { ok: true, progress: this.progress(exam, attempt, await this.work(attempt.id), questionId) };
  }

  /** The instructor marks a question of a finished attempt correct or not correct (null = automatic grade). */
  async setGradeOverride(attemptId: string, questionId: string, correct: boolean | null): Promise<'ok' | 'not-found' | 'in-progress'> {
    const attempt = await this.get(attemptId);
    const exam = attempt && this.examFor(attempt);
    if (!attempt || !exam?.questions.some((q) => q.id === questionId)) return 'not-found';
    if (attempt.status !== 'completed') return 'in-progress';
    await this.repos.attempts.setOverride(attemptId, questionId, correct, new Date().toISOString());
    console.log(`[audit] attempt ${attemptId} question ${questionId}: instructor set ${correct === null ? 'automatic grade' : correct ? 'correct' : 'not correct'}`);
    return 'ok';
  }

  /** Why a submission for this question would be refused, or null if allowed. */
  submitBlock(exam: ExamDefinition, attempt: AttemptRecord, questionId: string, subs: SubmissionRecord[]): SubmitBlock | null {
    if (attempt.status !== 'in_progress') return 'completed';
    if (attempt.lockedAt) return 'test-locked';
    const count = subs.filter((s) => s.questionId === questionId).length;
    if (exam.settings.lockAfterSubmit && count > 0) return 'locked';
    const max = effectiveMaxAttempts(exam.settings);
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

  /**
   * The points a student has on one question: full points for a correct
   * answer on any try; once the question is final (out of tries, or the exam
   * is over), partial credit for the share of checks passed on their best try.
   * Never lowered by trying again.
   */
  questionResult(
    exam: ExamDefinition,
    attempt: AttemptRecord,
    questionId: string,
    work: AttemptWork,
  ): QuestionResult {
    const question = exam.questions.find((q) => q.id === questionId);
    const override = work.overrides.get(questionId);
    if (override !== undefined) {
      return { passed: override, points: override ? (question?.points ?? 0) : 0, partial: false, final: true, submitted: true };
    }
    if (question?.answer) {
      const answer = work.answers.get(questionId);
      const correct = answer !== undefined && isAnswerCorrect(question.answer, answer);
      return {
        passed: correct,
        points: correct ? question.points : 0,
        partial: false,
        final: attempt.status === 'completed',
        submitted: answer !== undefined,
      };
    }
    const mine = work.submissions.filter((s) => s.questionId === questionId);
    const passed = mine.some((s) => s.passed);
    const final = attempt.status === 'completed' || passed || this.noTriesLeft(exam, mine.length);
    let points = 0;
    for (const s of mine) {
      // Full points for a correct answer (earlier versions stored less for later tries).
      const value = s.passed ? (question?.points ?? s.maxPoints) * s.score : final && question ? partialPoints(exam, question, s) : 0;
      points = Math.max(points, value);
    }
    points = round2(points);
    return { passed, points, partial: !passed && points > 0, final, submitted: mine.length > 0 };
  }

  private noTriesLeft(exam: ExamDefinition, count: number): boolean {
    if (exam.settings.lockAfterSubmit && count > 0) return true;
    const max = effectiveMaxAttempts(exam.settings);
    return max !== null && count >= max;
  }

  progress(exam: ExamDefinition, attempt: AttemptRecord, work: AttemptWork, questionId: string): QuestionProgress {
    const result = this.questionResult(exam, attempt, questionId, work);
    if (exam.questions.find((q) => q.id === questionId)?.answer) {
      // Written: answers can change until the test ends; results only come after that.
      const over = attempt.status === 'completed';
      return {
        questionId,
        attempts: work.answers.has(questionId) ? 1 : 0,
        attemptsRemaining: null,
        locked: over || attempt.lockedAt !== null,
        best: over && result.submitted ? { passed: result.passed, pointsAwarded: result.points, partial: false } : null,
      };
    }
    const subs = work.submissions;
    const mine = subs.filter((s) => s.questionId === questionId);
    const max = effectiveMaxAttempts(exam.settings);
    const revealed = exam.settings.showFeedback || attempt.status === 'completed';
    const locked = this.submitBlock(exam, attempt, questionId, subs) !== null;
    return {
      questionId,
      attempts: mine.length,
      attemptsRemaining: max === null ? null : Math.max(0, max - mine.length),
      locked,
      best: result.submitted && revealed ? { passed: result.passed, pointsAwarded: result.points, partial: result.partial } : null,
    };
  }

  score(exam: ExamDefinition, attempt: AttemptRecord, work: AttemptWork): ScoreView {
    const questions = orderedQuestions(exam);
    return {
      earned: round2(questions.reduce((sum, q) => sum + this.questionResult(exam, attempt, q.id, work).points, 0)),
      max: questions.reduce((sum, q) => sum + q.points, 0),
    };
  }

  /** The student's view of their attempt; hides what the exam settings hide. */
  async view(exam: ExamDefinition, attempt: AttemptRecord): Promise<AttemptView> {
    const work = await this.work(attempt.id);
    const written = isWrittenExam(exam.settings);
    // A running score would tell a written test's students which answers are right.
    const scoreVisible = (exam.settings.showScoreDuringExam && !written) || attempt.status === 'completed';
    return {
      id: attempt.id,
      status: attempt.status,
      startedAt: attempt.startedAt,
      deadlineAt: attempt.deadlineAt,
      serverTime: new Date().toISOString(),
      currentQuestionId: attempt.currentQuestionId,
      locked: attempt.lockedAt ? { at: attempt.lockedAt, reason: attempt.lockReason ?? '' } : null,
      score: scoreVisible ? this.score(exam, attempt, work) : null,
      questions: orderedQuestions(exam).map((q) => this.progress(exam, attempt, work, q.id)),
      ...(written ? { answers: Object.fromEntries(work.answers) } : {}),
    };
  }

  /** Final results. Only valid for completed attempts. */
  async result(exam: ExamDefinition, attempt: AttemptRecord): Promise<ExamResultView> {
    const work = await this.work(attempt.id);
    const score = this.score(exam, attempt, work);
    return {
      examTitle: exam.title,
      studentName: attempt.studentName,
      className: attempt.className,
      startedAt: attempt.startedAt,
      completedAt: attempt.completedAt ?? new Date().toISOString(),
      endReason: attempt.endReason ?? 'finished',
      score,
      percentage: score.max === 0 ? 0 : Math.round((score.earned / score.max) * 1000) / 10,
      canRetake: exam.settings.mode === 'practice',
      questions: orderedQuestions(exam).map((q, i) => {
        const r = this.questionResult(exam, attempt, q.id, work);
        return {
          questionId: q.id,
          number: i + 1,
          title: q.title,
          pointsAwarded: r.points,
          maxPoints: q.points,
          passed: r.passed,
          partial: r.partial,
          attempts: this.progress(exam, attempt, work, q.id).attempts,
        };
      }),
    };
  }
}

export interface QuestionResult {
  passed: boolean;
  points: number;
  /** Not fully correct, but earned partial credit. */
  partial: boolean;
  /** No more tries can change the result (correct, out of tries, or exam over). */
  final: boolean;
  submitted: boolean;
}

/**
 * Partial credit for one wrong submission: share of checks passed x points.
 * Only for questions where all checks must pass (when any one check is
 * enough, a passing check already means full marks).
 */
function partialPoints(exam: ExamDefinition, question: ExamDefinition['questions'][number], s: SubmissionRecord): number {
  if (exam.settings.partialCredit === false || question.validation.mode !== 'all') return 0;
  const rules = Array.isArray(s.ruleResults) ? (s.ruleResults as Array<{ passed?: unknown }>) : [];
  if (rules.length === 0) return 0;
  const share = rules.filter((r) => r.passed === true).length / rules.length;
  return question.points * share;
}

function isOverdue(a: AttemptRecord): boolean {
  return a.status === 'in_progress' && a.deadlineAt !== null && Date.parse(a.deadlineAt) <= Date.now();
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
