import {
  AUTHORING_LIMITS,
  validateExamSettings,
  validateQuestionContent,
  type AiStatus,
  type ExamDetail,
  type ExamSummary,
  type GenerateQuestionsRequest,
  type GenerateQuestionsResponse,
  type InstructorQuestion,
  type QuestionSource,
} from '@linuxlab/shared';
import type { ContainerRuntime } from '../containers/index.js';
import { toInstructorQuestion, UNTESTED, type ExamCatalog } from '../exams/examCatalog.js';
import { practiceSettings } from '../exams/sampleExam.js';
import { GenerationError, type QuestionGenerator } from './questionGenerator.js';
import { verifyQuestion } from './questionVerifier.js';

/** A rule was broken; the message is safe to show the instructor. */
export class AuthoringError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 429 | 502 | 503,
    message: string,
  ) {
    super(message);
  }
}

/** AI requests per hour, to keep API costs predictable. */
const GENERATIONS_PER_HOUR = 20;

/**
 * Everything instructors do to exams and questions, with the rules that keep
 * students safe:
 *  - new and edited questions are drafts; students only see approved ones
 *  - a question can only be approved after its sandbox test passed
 *  - editing an approved question sends it back to draft (and re-tests it)
 *  - only an exam with approved questions can be made active
 */
export class AuthoringService {
  // Sandbox tests run one at a time in the background.
  private verifyQueue: Promise<void> = Promise.resolve();
  private readonly recentGenerations: number[] = [];
  private generating = false;

  constructor(
    private readonly catalog: ExamCatalog,
    private readonly runtime: ContainerRuntime,
    private readonly generator: QuestionGenerator,
  ) {}

  aiStatus(): AiStatus {
    return { enabled: this.generator.enabled, model: this.generator.model };
  }

  /** Has the AI draft questions into an exam. Drafts are tested, then wait for approval. */
  async generate(examId: string, body: unknown): Promise<GenerateQuestionsResponse> {
    const exam = this.examDetail(examId);
    const request = parseGenerateRequest(body);
    if (!this.generator.enabled) throw new AuthoringError(503, 'AI question writing is not set up: add OPENAI_API_KEY to the .env file.');
    if (this.generating) throw new AuthoringError(429, 'Questions are already being generated. Please wait for them to finish.');
    const hourAgo = Date.now() - 3_600_000;
    while (this.recentGenerations.length && this.recentGenerations[0]! < hourAgo) this.recentGenerations.shift();
    if (this.recentGenerations.length >= GENERATIONS_PER_HOUR) {
      throw new AuthoringError(429, `Limit of ${GENERATIONS_PER_HOUR} AI requests per hour reached. Try again later.`);
    }

    this.generating = true;
    this.recentGenerations.push(Date.now());
    try {
      const drafts = await this.generator.generate(request, exam.questions.map((q) => q.content.title), {
        allowSudo: exam.settings.allowSudo === true,
      });
      const created: InstructorQuestion[] = [];
      for (const content of drafts.valid) {
        const q = await this.catalog.addQuestion(examId, content, 'ai');
        this.queueVerification(q.id);
        created.push(toInstructorQuestion(q));
      }
      return { created, rejected: drafts.rejected };
    } catch (err) {
      if (err instanceof GenerationError) throw new AuthoringError(502, err.message);
      throw err;
    } finally {
      this.generating = false;
    }
  }

  listExams(): ExamSummary[] {
    return this.catalog.listExams();
  }

  examDetail(id: string): ExamDetail {
    const exam = this.catalog.examDetail(id);
    if (!exam) throw new AuthoringError(404, 'Exam not found');
    return exam;
  }

  async createExam(title: unknown): Promise<ExamDetail> {
    const t = typeof title === 'string' ? title.trim() : '';
    if (!t || t.length > 120) throw new AuthoringError(400, 'Exam title is required (max 120 characters).');
    const id = await this.catalog.createExam(t, practiceSettings);
    return this.examDetail(id);
  }

  async updateExam(id: string, body: unknown): Promise<ExamDetail> {
    const before = this.examDetail(id);
    const raw = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    const title = typeof raw.title === 'string' ? raw.title.trim() : '';
    const description = typeof raw.description === 'string' ? raw.description.trim() : '';
    if (!title || title.length > 120) throw new AuthoringError(400, 'Exam title is required (max 120 characters).');
    if (description.length > 1000) throw new AuthoringError(400, 'Description is too long (max 1000 characters).');
    const settings = validateExamSettings(raw.settings);
    if (!settings.ok) throw new AuthoringError(400, settings.errors.join(' '));
    await this.catalog.updateExam(id, { title, description: description || null, settings: settings.value });
    // Turning sudo on or off changes what students can do: re-test every
    // question in the new environment (failures are un-approved automatically).
    if ((before.settings.allowSudo === true) !== (settings.value.allowSudo === true)) {
      for (const q of before.questions) this.queueVerification(q.id);
    }
    return this.examDetail(id);
  }

  async deleteExam(id: string): Promise<void> {
    const exam = this.examDetail(id);
    if (exam.enabled) throw new AuthoringError(409, 'Disable this test before deleting it.');
    await this.catalog.deleteExam(id);
  }

  /**
   * Opens or closes a test for students. Disabling only hides it from the
   * start screen: students already taking it can finish.
   */
  async setEnabled(id: string, enabled: boolean): Promise<ExamDetail> {
    const exam = this.examDetail(id);
    if (enabled && exam.approvedCount === 0) {
      throw new AuthoringError(409, 'Approve at least one question before enabling this test.');
    }
    await this.catalog.setEnabled(id, enabled);
    return this.examDetail(id);
  }

  async addQuestion(examId: string, body: unknown, source: QuestionSource = 'manual'): Promise<InstructorQuestion> {
    this.examDetail(examId);
    const checked = validateQuestionContent(body);
    if (!checked.ok) throw new AuthoringError(400, checked.errors.join(' '));
    const q = await this.catalog.addQuestion(examId, checked.value, source);
    this.queueVerification(q.id);
    return toInstructorQuestion(q);
  }

  async updateQuestion(examId: string, questionId: string, body: unknown): Promise<InstructorQuestion> {
    this.questionIn(examId, questionId);
    const checked = validateQuestionContent(body);
    if (!checked.ok) throw new AuthoringError(400, checked.errors.join(' '));
    // Changed content must be re-tested and re-approved.
    const q = await this.catalog.updateQuestion(questionId, { content: checked.value, status: 'draft', verification: UNTESTED });
    this.queueVerification(questionId);
    return toInstructorQuestion(q!);
  }

  async approve(examId: string, questionId: string): Promise<InstructorQuestion> {
    const q = this.questionIn(examId, questionId);
    if (q.verification.status !== 'passed') {
      throw new AuthoringError(409, 'Only questions that passed the sandbox test can be approved. Fix it, then test again.');
    }
    return toInstructorQuestion((await this.catalog.updateQuestion(questionId, { status: 'approved' }))!);
  }

  async unapprove(examId: string, questionId: string): Promise<InstructorQuestion> {
    this.questionIn(examId, questionId);
    return toInstructorQuestion((await this.catalog.updateQuestion(questionId, { status: 'draft' }))!);
  }

  async deleteQuestion(examId: string, questionId: string): Promise<void> {
    this.questionIn(examId, questionId);
    await this.catalog.deleteQuestion(questionId);
  }

  async reorder(examId: string, order: unknown): Promise<ExamDetail> {
    const exam = this.examDetail(examId);
    const ids = Array.isArray(order) ? order.filter((x): x is string => typeof x === 'string') : [];
    const current = new Set(exam.questions.map((q) => q.id));
    if (ids.length !== current.size || !ids.every((id) => current.has(id))) {
      throw new AuthoringError(400, 'The new order must list every question of the exam exactly once.');
    }
    await this.catalog.reorder(examId, ids);
    return this.examDetail(examId);
  }

  /** Re-runs the sandbox test (in the background). */
  retest(examId: string, questionId: string): void {
    this.questionIn(examId, questionId);
    this.queueVerification(questionId);
  }

  queueVerification(questionId: string): void {
    void this.catalog.updateQuestion(questionId, {
      verification: { ...UNTESTED, status: 'running', notes: ['Waiting for / running the sandbox test…'] },
    });
    this.verifyQueue = this.verifyQueue
      .then(async () => {
        const q = this.catalog.question(questionId);
        if (!q) return; // deleted meanwhile
        const allowSudo = this.catalog.examSettings(q.examId)?.allowSudo === true;
        const result = await verifyQuestion(this.runtime, q.content, { allowSudo });
        // Only record the result if the content wasn't edited during the test.
        const latest = this.catalog.question(questionId);
        if (latest && JSON.stringify(latest.content) === JSON.stringify(q.content)) {
          // An approved question that no longer passes must not stay live.
          const unapprove = result.status !== 'passed' && latest.status === 'approved';
          await this.catalog.updateQuestion(questionId, {
            verification: unapprove ? { ...result, notes: [...result.notes, 'Moved back to draft because the re-test failed.'] } : result,
            ...(unapprove ? { status: 'draft' as const } : {}),
          });
        }
        console.log(`[authoring] tested ${questionId}: ${result.status}`);
      })
      .catch((err: unknown) => console.warn(`[authoring] test of ${questionId} crashed:`, err));
  }

  private questionIn(examId: string, questionId: string) {
    const q = this.catalog.question(questionId);
    if (!q || q.examId !== examId) throw new AuthoringError(404, 'Question not found');
    return q;
  }
}

function parseGenerateRequest(body: unknown): GenerateQuestionsRequest {
  const raw = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const L = AUTHORING_LIMITS;
  const topic = typeof raw.topic === 'string' ? raw.topic.trim() : '';
  const notes = typeof raw.notes === 'string' ? raw.notes.trim() : '';
  const { count, pointsEach, difficulty } = raw;
  if (!topic || topic.length > L.topicMax) throw new AuthoringError(400, `Describe the topic (max ${L.topicMax} characters).`);
  if (notes.length > L.notesMax) throw new AuthoringError(400, `Notes are too long (max ${L.notesMax} characters).`);
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > L.generateCountMax) {
    throw new AuthoringError(400, `Number of questions must be 1 to ${L.generateCountMax}.`);
  }
  if (typeof pointsEach !== 'number' || !Number.isInteger(pointsEach) || pointsEach < 1 || pointsEach > L.pointsMax) {
    throw new AuthoringError(400, `Points per question must be 1 to ${L.pointsMax}.`);
  }
  if (difficulty !== 'beginner' && difficulty !== 'intermediate' && difficulty !== 'advanced') {
    throw new AuthoringError(400, 'Choose a difficulty.');
  }
  return { topic, count, difficulty, pointsEach, ...(notes ? { notes } : {}) };
}
