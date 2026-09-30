import { randomUUID } from 'node:crypto';
import type {
  ExamDetail,
  ExamSettings,
  ExamSummary,
  InstructorQuestion,
  QuestionContent,
  QuestionSource,
  QuestionStatus,
  QuestionVerification,
} from '@linuxlab/shared';
import { config } from '../../config.js';
import type { ExamQuestionRecord, ExamRecord, ExamRepository } from '../db/index.js';
import { examModeSettings, sampleExam } from './sampleExam.js';
import type { ExamDefinition, QuestionDefinition } from './types.js';

export const UNTESTED: QuestionVerification = {
  status: 'untested',
  checkedAt: null,
  passedBeforeSolution: null,
  passedAfterSolution: null,
  notes: [],
};

/**
 * All exams and questions, stored in the database and cached in memory so
 * student requests stay synchronous and fast. Every write goes to the
 * database first, then refreshes the cache.
 *
 * Students choose among *open* exams (enabled, with approved questions) and
 * only ever see the *approved* questions.
 */
export class ExamCatalog {
  private exams = new Map<string, ExamRecord>();
  private questions = new Map<string, ExamQuestionRecord[]>();

  constructor(private readonly repo: ExamRepository) {}

  async load(): Promise<void> {
    if ((await this.repo.list()).length === 0) await this.seedSampleExam();
    // A verification can't still be running after a restart.
    for (const q of await this.repo.allQuestions()) {
      if (q.verification.status === 'running') {
        await this.repo.saveQuestion({ ...q, verification: { ...UNTESTED, notes: ['Test interrupted by a server restart.'] } });
      }
    }
    await this.refresh();
  }

  /**
   * Reloads the cache from the database. Refreshes run strictly one after
   * another and swap in fully built maps, so overlapping writes (AI drafts
   * being added while sandbox tests finish) can never leave duplicate or
   * stale entries.
   */
  private refresh(): Promise<void> {
    this.refreshing = this.refreshing.then(() => this.reload()).catch((err: unknown) => {
      console.warn('[exams] could not refresh the exam list:', err);
    });
    return this.refreshing;
  }

  private refreshing: Promise<void> = Promise.resolve();

  private async reload(): Promise<void> {
    const exams = await this.repo.list();
    const questions = new Map<string, ExamQuestionRecord[]>();
    for (const q of await this.repo.allQuestions()) {
      const list = questions.get(q.examId) ?? [];
      list.push(q);
      questions.set(q.examId, list);
    }
    this.exams = new Map(exams.map((e) => [e.id, e]));
    this.questions = questions;
  }

  /** On a brand-new database: the MVP sample exam, approved and enabled. */
  private async seedSampleExam(): Promise<void> {
    const now = new Date().toISOString();
    const settings = config.sampleExamMode === 'exam' ? examModeSettings : sampleExam.settings;
    await this.repo.save({
      id: sampleExam.id,
      title: sampleExam.title,
      description: sampleExam.description ?? null,
      settings,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
    for (const q of sampleExam.questions) {
      const { id, order, labType: _lab, ...content } = q;
      await this.repo.saveQuestion({
        id,
        examId: sampleExam.id,
        position: order,
        status: 'approved',
        source: 'sample',
        content,
        verification: UNTESTED,
        createdAt: now,
        updatedAt: now,
      });
    }
    console.log('[exams] created the sample exam');
  }

  // ------------------------------------------------------------- students

  /** Exams students can choose right now: enabled and with approved questions. */
  openExams(): ExamDefinition[] {
    return [...this.exams.values()]
      .filter((e) => e.enabled)
      .sort((a, b) => a.title.localeCompare(b.title))
      .flatMap((e) => this.getExamById(e.id) ?? []);
  }

  /** One open exam, or undefined if it is disabled or has nothing approved. */
  openExam(id: string): ExamDefinition | undefined {
    return this.exams.get(id)?.enabled ? this.getExamById(id) : undefined;
  }

  /** An exam as students see it: approved questions only, in order. */
  getExamById(id: string): ExamDefinition | undefined {
    const exam = this.exams.get(id);
    if (!exam) return undefined;
    const questions: QuestionDefinition[] = (this.questions.get(id) ?? [])
      .filter((q) => q.status === 'approved')
      .sort((a, b) => a.position - b.position)
      .map((q, i) => ({ ...q.content, id: q.id, order: i + 1, labType: 'linux' }));
    if (questions.length === 0) return undefined;
    return {
      id: exam.id,
      title: exam.title,
      ...(exam.description ? { description: exam.description } : {}),
      settings: exam.settings,
      questions,
    };
  }

  // ----------------------------------------------------------- instructors

  listExams(): ExamSummary[] {
    return [...this.exams.values()].map((e) => this.summary(e));
  }

  examDetail(id: string): ExamDetail | undefined {
    const exam = this.exams.get(id);
    if (!exam) return undefined;
    return { ...this.summary(exam), questions: this.questionsOf(id).map(toInstructorQuestion) };
  }

  examSettings(examId: string): ExamSettings | undefined {
    return this.exams.get(examId)?.settings;
  }

  question(id: string): ExamQuestionRecord | undefined {
    for (const list of this.questions.values()) {
      const found = list.find((q) => q.id === id);
      if (found) return found;
    }
    return undefined;
  }

  async createExam(title: string, settings: ExamSettings): Promise<string> {
    const now = new Date().toISOString();
    const id = `exam-${randomUUID().slice(0, 8)}`;
    // New exams start disabled: students only see them once the instructor enables them.
    await this.repo.save({ id, title, description: null, settings, enabled: false, createdAt: now, updatedAt: now });
    await this.refresh();
    return id;
  }

  async updateExam(id: string, patch: { title: string; description: string | null; settings: ExamSettings }): Promise<void> {
    // Read the current record from the database, never the cache, so an
    // older cached value (e.g. "enabled") can't be written back.
    const exam = await this.repo.get(id);
    if (!exam) return;
    await this.repo.save({ ...exam, ...patch, updatedAt: new Date().toISOString() });
    await this.refresh();
  }

  async deleteExam(id: string): Promise<void> {
    await this.repo.delete(id);
    await this.refresh();
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const exam = await this.repo.get(id);
    if (!exam) return;
    await this.repo.save({ ...exam, enabled, updatedAt: new Date().toISOString() });
    await this.refresh();
  }

  async addQuestion(examId: string, content: QuestionContent, source: QuestionSource): Promise<ExamQuestionRecord> {
    const now = new Date().toISOString();
    const position = Math.max(0, ...this.questionsOf(examId).map((q) => q.position)) + 1;
    const record: ExamQuestionRecord = {
      id: `q-${randomUUID().slice(0, 12)}`,
      examId,
      position,
      status: 'draft', // nothing reaches students without approval
      source,
      content,
      verification: UNTESTED,
      createdAt: now,
      updatedAt: now,
    };
    await this.repo.saveQuestion(record);
    await this.refresh();
    return record;
  }

  async updateQuestion(
    id: string,
    patch: Partial<Pick<ExamQuestionRecord, 'content' | 'status' | 'verification'>>,
  ): Promise<ExamQuestionRecord | undefined> {
    const current = await this.repo.getQuestion(id);
    if (!current) return undefined;
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    await this.repo.saveQuestion(next);
    await this.refresh();
    return next;
  }

  async deleteQuestion(id: string): Promise<void> {
    await this.repo.deleteQuestion(id);
    await this.refresh();
  }

  async reorder(examId: string, ids: string[]): Promise<void> {
    await this.repo.reorder(examId, ids);
    await this.refresh();
  }

  private questionsOf(examId: string): ExamQuestionRecord[] {
    return [...(this.questions.get(examId) ?? [])].sort((a, b) => a.position - b.position);
  }

  private summary(e: ExamRecord): ExamSummary {
    const qs = this.questionsOf(e.id);
    const approved = qs.filter((q) => q.status === 'approved');
    return {
      id: e.id,
      title: e.title,
      description: e.description,
      enabled: e.enabled,
      open: e.enabled && approved.length > 0,
      settings: e.settings,
      approvedCount: approved.length,
      draftCount: qs.length - approved.length,
      totalPoints: approved.reduce((sum, q) => sum + q.content.points, 0),
    };
  }
}

export function toInstructorQuestion(q: ExamQuestionRecord): InstructorQuestion {
  return {
    id: q.id,
    position: q.position,
    status: q.status as QuestionStatus,
    source: q.source,
    content: q.content,
    verification: q.verification,
  };
}
