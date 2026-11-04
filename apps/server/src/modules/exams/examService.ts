import { createHash } from 'node:crypto';
import { effectiveMaxAttempts, isWrittenExam, usesLimitedTries, type StudentAnswerFormat, type StudentExam, type StudentQuestion } from '@linuxlab/shared';
import type { AttemptRecord } from '../db/index.js';
import type { ExamCatalog } from './examCatalog.js';
import type { ExamDefinition, QuestionDefinition } from './types.js';

// Where exams come from. The catalog is installed once at startup
// (setExamCatalog) so these lookups stay simple, synchronous functions.

let catalog: ExamCatalog | undefined;

export function setExamCatalog(c: ExamCatalog): void {
  catalog = c;
}

function requireCatalog(): ExamCatalog {
  if (!catalog) throw new Error('Exam catalog not initialised');
  return catalog;
}

/** Exams students may choose on the start screen. */
export function getOpenExams(): ExamDefinition[] {
  return requireCatalog().openExams();
}

/** One exam, only if it is currently open to students. */
export function getOpenExam(id: string): ExamDefinition | undefined {
  return requireCatalog().openExam(id);
}

export function getExamById(id: string): ExamDefinition | undefined {
  return requireCatalog().getExamById(id);
}

/**
 * The exam an attempt is being graded against: the copy frozen when it
 * started, so instructor edits never change an exam in progress. Attempts
 * from before snapshots existed fall back to the current exam.
 */
export function examForAttempt(attempt: AttemptRecord): ExamDefinition | undefined {
  const snap = attempt.examSnapshot as ExamDefinition | null;
  if (snap && typeof snap === 'object' && Array.isArray(snap.questions)) return snap;
  return getExamById(attempt.examId);
}

export function orderedQuestions(exam: ExamDefinition): QuestionDefinition[] {
  return [...exam.questions].sort((a, b) => a.order - b.order);
}

/**
 * The only way exam data reaches a student. Builds the view field by field
 * (an allow-list), so answers, setup, and model solutions can never leak.
 */
/** The same seed always gives the same order, so a student's order survives a refresh. */
function seededShuffle<T>(items: readonly T[], seed: string): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const roll = createHash('sha256').update(`${seed}:${i}`).digest().readUInt32BE(0);
    const j = roll % (i + 1);
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

function isShuffled(exam: ExamDefinition): boolean {
  return isWrittenExam(exam.settings) && exam.settings.shuffle === true;
}

/** The questions in the order this student sees them. */
export function questionsForAttempt(exam: ExamDefinition, attemptId: string): QuestionDefinition[] {
  const questions = orderedQuestions(exam);
  return isShuffled(exam) ? seededShuffle(questions, attemptId) : questions;
}

/** Only the choices: which one is correct (and any rubric) stays on the server. */
function studentAnswerFormat(exam: ExamDefinition, q: QuestionDefinition, attemptId: string): StudentAnswerFormat | undefined {
  if (!q.answer) return undefined;
  if (q.answer.type === 'fill_in_blank') return { type: 'fill_in_blank' };
  if (q.answer.type === 'short_answer') return { type: 'short_answer' };
  // Answers are saved as the choice's original position, so shuffling never affects grading.
  const choices = q.answer.choices.map((text, i) => ({ value: String(i), text }));
  return { type: 'multiple_choice', choices: isShuffled(exam) ? seededShuffle(choices, `${attemptId}:${q.id}`) : choices };
}

export function toStudentExam(exam: ExamDefinition, attemptId: string): StudentExam {
  const questions: StudentQuestion[] = questionsForAttempt(exam, attemptId).map((q, index) => ({
    id: q.id,
    number: index + 1,
    title: q.title,
    text: q.text,
    instructions: q.instructions,
    points: q.points,
    category: q.category,
    difficulty: q.difficulty,
    hint: exam.settings.allowHints ? q.hint : undefined,
    answerFormat: studentAnswerFormat(exam, q, attemptId),
  }));
  const s = exam.settings;
  return {
    id: exam.id,
    title: exam.title,
    examType: isWrittenExam(s) ? 'written' : 'linux',
    mode: s.mode,
    totalPoints: questions.reduce((sum, q) => sum + q.points, 0),
    rules: {
      timeLimitMinutes: s.timeLimitMinutes,
      maxAttemptsPerQuestion: effectiveMaxAttempts(s),
      showFeedback: s.showFeedback,
      showScoreDuringExam: s.showScoreDuringExam,
      lockAfterSubmit: s.lockAfterSubmit,
      lockOnLeave: s.lockOnLeave !== false,
      limitedTries: usesLimitedTries(s),
      partialCredit: s.partialCredit !== false,
    },
    questions,
  };
}
