import { effectiveMaxAttempts, type StudentExam, type StudentQuestion } from '@linuxlab/shared';
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
export function toStudentExam(exam: ExamDefinition): StudentExam {
  const questions: StudentQuestion[] = orderedQuestions(exam).map((q, index) => ({
    id: q.id,
    number: index + 1,
    title: q.title,
    text: q.text,
    instructions: q.instructions,
    points: q.points,
    category: q.category,
    difficulty: q.difficulty,
    hint: exam.settings.allowHints ? q.hint : undefined,
  }));
  const s = exam.settings;
  return {
    id: exam.id,
    title: exam.title,
    mode: s.mode,
    totalPoints: questions.reduce((sum, q) => sum + q.points, 0),
    rules: {
      timeLimitMinutes: s.timeLimitMinutes,
      maxAttemptsPerQuestion: effectiveMaxAttempts(s),
      showFeedback: s.showFeedback,
      showScoreDuringExam: s.showScoreDuringExam,
      lockAfterSubmit: s.lockAfterSubmit,
      lockOnLeave: s.lockOnLeave !== false,
      threeTries: s.threeTries !== false,
    },
    questions,
  };
}
