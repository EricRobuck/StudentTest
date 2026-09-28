import type {
  AttemptDetail,
  AttemptSummary,
  FsSnapshotView,
  InstructorCommand,
  InstructorRuleResult,
} from '@linuxlab/shared';
import type { AttemptService } from '../attempts/attemptService.js';
import type { AttemptRecord, CommandLogRecord, Repositories, SubmissionRecord } from '../db/index.js';
import { orderedQuestions } from '../exams/examService.js';
import type { ExamDefinition } from '../exams/types.js';

/** Read-only views of student work for instructors (requirements §11, §16). */
export class InstructorService {
  constructor(
    private readonly repos: Repositories,
    private readonly attempts: AttemptService,
    private readonly examById: (id: string) => ExamDefinition | undefined,
  ) {}

  async listAttempts(): Promise<AttemptSummary[]> {
    await this.attempts.expireOverdue(); // show accurate statuses
    const summaries: AttemptSummary[] = [];
    for (const attempt of await this.repos.attempts.listAll()) {
      const exam = this.examById(attempt.examId);
      if (!exam) continue;
      const [subs, commands] = await Promise.all([
        this.repos.submissions.listForAttempt(attempt.id),
        this.repos.commands.listForAttempt(attempt.id),
      ]);
      summaries.push(this.summary(exam, attempt, subs, commands));
    }
    return summaries;
  }

  async attemptDetail(attemptId: string): Promise<AttemptDetail | undefined> {
    const attempt = await this.attempts.get(attemptId);
    const exam = attempt && this.examById(attempt.examId);
    if (!attempt || !exam) return undefined;

    const [subs, commands, visits, snapshots] = await Promise.all([
      this.repos.submissions.listForAttempt(attempt.id),
      this.repos.commands.listForAttempt(attempt.id),
      this.repos.attempts.visits(attempt.id),
      this.repos.snapshots.forAttempt(attempt.id),
    ]);
    const timeSpent = timeSpentPerQuestion(visits, attempt.completedAt ?? new Date().toISOString());
    const questionIds = new Set(exam.questions.map((q) => q.id));

    const questions = orderedQuestions(exam).map((q, i) => {
      const mine = subs.filter((s) => s.questionId === q.id);
      const best = mine.reduce<SubmissionRecord | undefined>((b, s) => (!b || s.pointsAwarded > b.pointsAwarded ? s : b), undefined);
      return {
        questionId: q.id,
        number: i + 1,
        title: q.title,
        text: q.text,
        maxPoints: q.points,
        pointsAwarded: best?.pointsAwarded ?? 0,
        passed: best?.passed ?? false,
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
      summary: this.summary(exam, attempt, subs, commands),
      questions,
      unassignedCommands: commands.filter((c) => !c.questionId || !questionIds.has(c.questionId)).map(toCommand),
      snapshot: latest ? (latest.data as FsSnapshotView) : null,
    };
  }

  private summary(
    exam: ExamDefinition,
    attempt: AttemptRecord,
    subs: SubmissionRecord[],
    commands: CommandLogRecord[],
  ): AttemptSummary {
    const score = this.attempts.score(exam, subs);
    return {
      id: attempt.id,
      examId: exam.id,
      examTitle: exam.title,
      status: attempt.status,
      endReason: attempt.endReason,
      startedAt: attempt.startedAt,
      completedAt: attempt.completedAt,
      score,
      percentage: score.max === 0 ? 0 : Math.round((score.earned / score.max) * 1000) / 10,
      submissionCount: subs.length,
      commandCount: commands.length,
      flaggedCommandCount: commands.filter((c) => c.flags.length > 0).length,
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
