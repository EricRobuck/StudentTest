import {
  isAnswerCorrect,
  isWrittenExam,
  type AttemptDetail,
  type AttemptSummary,
  type ExamAnalysis,
  type GradingQuestion,
  type GradingQueue,
  type QuestionAnalysis,
  type QuestionFormat,
  type SuggestGradesResult,
  type ValidatorSpec,
  type FsSnapshotView,
  type InstructorCommand,
  type InstructorRuleResult,
} from '@linuxlab/shared';
import type { AttemptService, AttemptWork } from '../attempts/attemptService.js';
import type { AnswerGrader } from '../authoring/answerGrader.js';
import type { AttemptRecord, CommandLogRecord, IntegrityEventRecord, Repositories } from '../db/index.js';
import { orderedQuestions } from '../exams/examService.js';
import type { ExamDefinition } from '../exams/types.js';

/** Read-only views of student work for instructors (requirements §11, §16). */
export class InstructorService {
  constructor(
    private readonly repos: Repositories,
    private readonly attempts: AttemptService,
    private readonly examFor: (attempt: AttemptRecord) => ExamDefinition | undefined,
    private readonly grader: AnswerGrader,
  ) {}

  private gradingInProgress = false;

  /** One professor's attempts: never another professor's students. */
  async listAttempts(ownerId: string): Promise<AttemptSummary[]> {
    await this.attempts.expireOverdue(); // show accurate statuses
    const summaries: AttemptSummary[] = [];
    for (const attempt of await this.repos.attempts.listAll()) {
      if (attempt.ownerId !== ownerId) continue;
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

    const [work, commands, visits, snapshots, events, suggestions] = await Promise.all([
      this.attempts.work(attempt.id),
      this.repos.commands.listForAttempt(attempt.id),
      this.repos.attempts.visits(attempt.id),
      this.repos.snapshots.forAttempt(attempt.id),
      this.repos.attempts.integrityEvents(attempt.id),
      this.repos.attempts.suggestions(attempt.id),
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
        override: work.overrides.get(q.id)?.correct ?? null,
        pending: result.pending,
        suggestion: toSuggestion(suggestions.find((s) => s.questionId === q.id)),
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

  /** A professor's finished attempts on one test (works after the test itself was deleted). */
  private async finishedAttempts(examId: string, ownerId: string): Promise<Array<{ attempt: AttemptRecord; exam: ExamDefinition }>> {
    await this.attempts.expireOverdue();
    const found: Array<{ attempt: AttemptRecord; exam: ExamDefinition }> = [];
    for (const attempt of await this.repos.attempts.listAll()) {
      if (attempt.ownerId !== ownerId || attempt.examId !== examId || attempt.status !== 'completed') continue;
      const exam = this.examFor(attempt);
      if (exam) found.push({ attempt, exam });
    }
    return found;
  }

  /** Every short answer on a test, one question at a time, for grading. */
  async gradingQueue(examId: string, ownerId: string): Promise<GradingQueue> {
    const finished = await this.finishedAttempts(examId, ownerId);
    const questions = new Map<string, GradingQuestion>();
    for (const { attempt, exam } of finished) {
      const [work, suggestions] = await Promise.all([this.attempts.work(attempt.id), this.repos.attempts.suggestions(attempt.id)]);
      for (const q of orderedQuestions(exam)) {
        if (q.answer?.type !== 'short_answer') continue;
        const group =
          questions.get(q.id) ??
          ({
            questionId: q.id,
            title: q.title,
            text: q.text,
            maxPoints: q.points,
            rubric: q.answer.rubric,
            sampleAnswer: q.answer.sampleAnswer ?? null,
            answers: [],
          } satisfies GradingQuestion);
        questions.set(q.id, group);
        const answer = work.answers.get(q.id);
        const override = work.overrides.get(q.id);
        if (answer === undefined && !override) continue;
        const result = this.attempts.questionResult(exam, attempt, q.id, work);
        group.answers.push({
          attemptId: attempt.id,
          studentName: attempt.studentName,
          className: attempt.className,
          answer: answer ?? '',
          points: result.pending ? null : result.points,
          suggestion: toSuggestion(suggestions.find((s) => s.questionId === q.id)),
        });
      }
    }
    return {
      examTitle: finished[0]?.exam.title ?? null,
      aiEnabled: this.grader.enabled,
      questions: [...questions.values()],
    };
  }

  /**
   * Has AI suggest points for the ungraded answers to one question. Student
   * names are never sent, and nothing counts until the instructor accepts it.
   */
  async suggestGrades(examId: string, questionId: string, ownerId: string): Promise<SuggestGradesResult | 'not-found' | 'busy' | 'disabled'> {
    if (!this.grader.enabled) return 'disabled';
    if (this.gradingInProgress) return 'busy';
    this.gradingInProgress = true;
    try {
      const todo: Array<{ attemptId: string; answer: string; exam: ExamDefinition }> = [];
      let exists = false;
      for (const { attempt, exam } of await this.finishedAttempts(examId, ownerId)) {
        const question = exam.questions.find((q) => q.id === questionId);
        if (question?.answer?.type !== 'short_answer') continue;
        exists = true;
        const [work, suggestions] = await Promise.all([this.attempts.work(attempt.id), this.repos.attempts.suggestions(attempt.id)]);
        const answer = work.answers.get(questionId);
        if (answer === undefined || work.overrides.has(questionId) || suggestions.some((s) => s.questionId === questionId)) continue;
        todo.push({ attemptId: attempt.id, answer, exam });
      }
      if (!exists) return 'not-found';

      let suggested = 0;
      for (let i = 0; i < todo.length; i += GRADING_BATCH) {
        const batch = todo.slice(i, i + GRADING_BATCH);
        const q = batch[0]!.exam.questions.find((x) => x.id === questionId)!;
        if (q.answer?.type !== 'short_answer') continue;
        // Answers get neutral ids; the attempt id stays here.
        const grades = await this.grader.grade({
          question: q.text,
          rubric: q.answer.rubric,
          ...(q.answer.sampleAnswer ? { sampleAnswer: q.answer.sampleAnswer } : {}),
          maxPoints: q.points,
          answers: batch.map((item, n) => ({ id: `answer-${n + 1}`, text: item.answer })),
        });
        for (const [n, item] of batch.entries()) {
          const grade = grades.get(`answer-${n + 1}`);
          if (!grade) continue;
          await this.repos.attempts.saveSuggestion(item.attemptId, questionId, { ...grade, model: this.grader.model }, new Date().toISOString());
          suggested++;
        }
      }
      return { suggested, remaining: todo.length - suggested };
    } finally {
      this.gradingInProgress = false;
    }
  }

  /** How each question of a test went, across all finished attempts. */
  async examAnalysis(examId: string, ownerId: string): Promise<ExamAnalysis> {
    const finished = await this.finishedAttempts(examId, ownerId);
    const rows = new Map<string, QuestionTally>();
    for (const { attempt, exam } of finished) {
      const work = await this.attempts.work(attempt.id);
      for (const q of orderedQuestions(exam)) {
        const row = rows.get(q.id) ?? newTally(q);
        rows.set(q.id, row);
        const result = this.attempts.questionResult(exam, attempt, q.id, work);
        row.attempts++;
        if (result.submitted) row.answered++;
        if (result.passed) row.correct++;
        if (result.pending) row.pending++;
        else row.pointsTotal += result.points;

        const answer = work.answers.get(q.id);
        if (q.answer?.type === 'multiple_choice') {
          // Each attempt has its own frozen copy, so count by the text the student saw.
          q.answer.choices.forEach((text, i) => {
            const choice = row.choices.get(text) ?? { count: 0, correct: false };
            if (i === (q.answer as { correctIndex: number }).correctIndex) choice.correct = true;
            if (answer === String(i)) choice.count++;
            row.choices.set(text, choice);
          });
        } else if (q.answer?.type === 'fill_in_blank' && answer && !isAnswerCorrect(q.answer, answer)) {
          const key = answer.trim().replace(/\s+/g, ' ').toLowerCase();
          row.wrongAnswers.set(key, (row.wrongAnswers.get(key) ?? 0) + 1);
        } else if (!q.answer) {
          const mine = work.submissions.filter((s) => s.questionId === q.id);
          if (mine.length > 0) {
            row.triesTotal += mine.length;
            row.triers++;
            const last = toRuleResults(mine.at(-1)!.ruleResults);
            q.validation.rules.forEach((rule, i) => {
              const label = describeCheck(rule);
              const check = row.checks.get(label) ?? { passed: 0, total: 0 };
              check.total++;
              if (last[i]?.passed) check.passed++;
              row.checks.set(label, check);
            });
          }
        }
      }
    }
    const questions = [...rows.values()].map((row, i): QuestionAnalysis => {
      const graded = row.attempts - row.pending;
      return {
        questionId: row.questionId,
        number: i + 1,
        title: row.title,
        text: row.text,
        format: row.format,
        maxPoints: row.maxPoints,
        attempts: row.attempts,
        answered: row.answered,
        correct: row.correct,
        pending: row.pending,
        percentCorrect: graded > 0 ? Math.round((row.correct / graded) * 1000) / 10 : null,
        averagePoints: graded > 0 ? Math.round((row.pointsTotal / graded) * 100) / 100 : null,
        ...(row.format === 'multiple_choice' ? { choices: [...row.choices].map(([text, c]) => ({ text, ...c })) } : {}),
        ...(row.format === 'fill_in_blank'
          ? {
              wrongAnswers: [...row.wrongAnswers]
                .map(([answer, count]) => ({ answer, count }))
                .sort((a, b) => b.count - a.count)
                .slice(0, TOP_WRONG_ANSWERS),
            }
          : {}),
        ...(row.format === 'linux'
          ? {
              checks: [...row.checks].map(([label, c]) => ({ label, ...c })),
              ...(row.triers > 0 ? { averageTries: Math.round((row.triesTotal / row.triers) * 10) / 10 } : {}),
            }
          : {}),
      };
    });
    return { examTitle: finished[0]?.exam.title ?? null, finishedAttempts: finished.length, questions };
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
      pendingGrades: exam.questions.filter((q) => this.attempts.questionResult(exam, attempt, q.id, work).pending).length,
    };
  }
}

/** Answers sent to the AI in one request. */
const GRADING_BATCH = 20;
const TOP_WRONG_ANSWERS = 8;

interface QuestionTally {
  questionId: string;
  title: string;
  text: string;
  format: QuestionFormat;
  maxPoints: number;
  attempts: number;
  answered: number;
  correct: number;
  pending: number;
  pointsTotal: number;
  choices: Map<string, { count: number; correct: boolean }>;
  wrongAnswers: Map<string, number>;
  checks: Map<string, { passed: number; total: number }>;
  triesTotal: number;
  triers: number;
}

function newTally(q: ExamDefinition['questions'][number]): QuestionTally {
  return {
    questionId: q.id,
    title: q.title,
    text: q.text,
    format: q.answer?.type ?? 'linux',
    maxPoints: q.points,
    attempts: 0,
    answered: 0,
    correct: 0,
    pending: 0,
    pointsTotal: 0,
    choices: new Map(),
    wrongAnswers: new Map(),
    checks: new Map(),
    triesTotal: 0,
    triers: 0,
  };
}

function describeCheck(r: ValidatorSpec): string {
  switch (r.type) {
    case 'current_directory':
      return `terminal is in ${r.path}`;
    case 'directory_exists':
      return `directory ${r.path} exists`;
    case 'file_exists':
      return `file ${r.path} exists`;
    case 'file_contains':
      return `${r.path} contains "${r.text}"`;
    case 'file_permissions':
      return `${r.path} has permissions ${r.mode}`;
  }
}

function toSuggestion(s: { points: number; reasoning: string; model: string } | undefined) {
  return s ? { points: s.points, reasoning: s.reasoning, model: s.model } : null;
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
