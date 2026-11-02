import {
  isWrittenExam,
  type AttemptDetail,
  type AttemptSummary,
  type FsSnapshotView,
  type InstructorCommand,
  type InstructorRuleResult,
} from '@linuxlab/shared';
import type { AttemptService, AttemptWork } from '../attempts/attemptService.js';
import type { AttemptRecord, CommandLogRecord, IntegrityEventRecord, Repositories } from '../db/index.js';
import { orderedQuestions } from '../exams/examService.js';
import type { ExamDefinition } from '../exams/types.js';

/** Read-only views of student work for instructors (requirements §11, §16). */
export class InstructorService {
  constructor(
    private readonly repos: Repositories,
    private readonly attempts: AttemptService,
    private readonly examFor: (attempt: AttemptRecord) => ExamDefinition | undefined,
  ) {}

  async listAttempts(): Promise<AttemptSummary[]> {
    await this.attempts.expireOverdue(); // show accurate statuses
    const summaries: AttemptSummary[] = [];
    for (const attempt of await this.repos.attempts.listAll()) {
      const exam = this.examFor(attempt);
      if (!exam) continue;
      const [work, commands, events] = await Promise.all([
        this.attempts.work(attempt.id),
        this.repos.commands.listForAttempt(attempt.id),
        this.repos.attempts.integrityEvents(attempt.id),
      ]);
      summaries.push(this.summary(exam, attempt, work, commands, events));
    }
    return summaries;
  }

  async attemptDetail(attemptId: string): Promise<AttemptDetail | undefined> {
    const attempt = await this.attempts.get(attemptId);
    const exam = attempt && this.examFor(attempt);
    if (!attempt || !exam) return undefined;

    const [work, commands, visits, snapshots, events] = await Promise.all([
      this.attempts.work(attempt.id),
      this.repos.commands.listForAttempt(attempt.id),
      this.repos.attempts.visits(attempt.id),
      this.repos.snapshots.forAttempt(attempt.id),
      this.repos.attempts.integrityEvents(attempt.id),
    ]);
    const timeSpent = timeSpentPerQuestion(visits, attempt.completedAt ?? new Date().toISOString());
    const questionIds = new Set(exam.questions.map((q) => q.id));

    const questions = orderedQuestions(exam).map((q, i) => {
      const mine = work.submissions.filter((s) => s.questionId === q.id);
      const result = this.attempts.questionResult(exam, attempt, q.id, work);
      const automatic = this.attempts.questionResult(exam, attempt, q.id, { ...work, overrides: new Map() });
      return {
        questionId: q.id,
        number: i + 1,
        title: q.title,
        text: q.text,
        maxPoints: q.points,
        pointsAwarded: result.points,
        passed: result.passed,
        partial: result.partial,
        autoPassed: automatic.passed,
        override: work.overrides.get(q.id) ?? null,
        answerKey: q.answer ?? null,
        studentAnswer: work.answers.get(q.id) ?? null,
        validation: q.validation,
        timeSpentSeconds: Math.round((timeSpent.get(q.id) ?? 0) / 1000),
        submissions: mine.map((s) => ({
          attemptNumber: s.attemptNumber,
          submittedAt: s.submittedAt,
          passed: s.passed,
          pointsAwarded: s.pointsAwarded,
          maxPoints: s.maxPoints,
          rules: toRuleResults(s.ruleResults),
        })),
        commands: commands.filter((c) => c.questionId === q.id).map(toCommand),
      };
    });

    const latest = snapshots.at(-1);
    return {
      summary: this.summary(exam, attempt, work, commands, events),
      questions,
      unassignedCommands: commands.filter((c) => !c.questionId || !questionIds.has(c.questionId)).map(toCommand),
      integrityEvents: events,
      snapshot: latest ? (latest.data as FsSnapshotView) : null,
    };
  }

  private summary(
    exam: ExamDefinition,
    attempt: AttemptRecord,
    work: AttemptWork,
    commands: CommandLogRecord[],
    events: IntegrityEventRecord[],
  ): AttemptSummary {
    const score = this.attempts.score(exam, attempt, work);
    return {
      id: attempt.id,
      examId: exam.id,
      examTitle: exam.title,
      studentName: attempt.studentName,
      className: attempt.className,
      status: attempt.status,
      endReason: attempt.endReason,
      startedAt: attempt.startedAt,
      completedAt: attempt.completedAt,
      score,
      percentage: score.max === 0 ? 0 : Math.round((score.earned / score.max) * 1000) / 10,
      submissionCount: work.submissions.length + work.answers.size,
      commandCount: commands.length,
      flaggedCommandCount: commands.filter((c) => c.flags.length > 0).length,
      lockedAt: attempt.lockedAt,
      lockReason: attempt.lockReason,
      timesLeft: events.filter((e) => e.type === 'left').length,
      examType: isWrittenExam(exam.settings) ? 'written' : 'linux',
    };
  }
}

/** Milliseconds each question was the open one, from the visit log. */
function timeSpentPerQuestion(visits: Array<{ questionId: string; enteredAt: string }>, endAt: string): Map<string, number> {
  const totals = new Map<string, number>();
  visits.forEach((v, i) => {
    const until = Date.parse(visits[i + 1]?.enteredAt ?? endAt);
    const ms = Math.max(0, until - Date.parse(v.enteredAt));
    totals.set(v.questionId, (totals.get(v.questionId) ?? 0) + ms);
  });
  return totals;
}

function toCommand(c: CommandLogRecord): InstructorCommand {
  return {
    seq: c.seq,
    executedAt: c.executedAt,
    questionId: c.questionId,
    cwd: c.cwd,
    command: c.command,
    exitCode: c.exitCode,
    flags: c.flags,
  };
}

/** Stored rule results are JSON from grading; read them defensively. */
function toRuleResults(raw: unknown): InstructorRuleResult[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((r: Record<string, unknown>) => ({
    type: r.type as InstructorRuleResult['type'],
    passed: r.passed === true,
    message: typeof r.message === 'string' ? r.message : '',
    detail: typeof r.detail === 'string' ? r.detail : undefined,
  }));
}
