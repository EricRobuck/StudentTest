import type { StudentExam, StudentQuestion } from '@linuxlab/shared';
import { config } from '../../config.js';
import { examModeSettings, sampleExam } from './sampleExam.js';
import type { ExamDefinition, QuestionDefinition } from './types.js';

const activeExam: ExamDefinition =
  config.sampleExamMode === 'exam' ? { ...sampleExam, settings: examModeSettings } : sampleExam;

/** The exam new attempts are started on. Later: chosen by instructor assignment. */
export function getActiveExam(): ExamDefinition {
  return activeExam;
}

/** Looks up the exam an existing attempt belongs to. */
export function getExamById(id: string): ExamDefinition | undefined {
  return id === activeExam.id ? activeExam : undefined;
}

export function orderedQuestions(exam: ExamDefinition): QuestionDefinition[] {
  return [...exam.questions].sort((a, b) => a.order - b.order);
}

/**
 * The only way exam data reaches a student. Builds the view field by field
 * (an allow-list), so adding a new secret field to QuestionDefinition can
 * never leak it by accident.
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
      maxAttemptsPerQuestion: s.maxAttemptsPerQuestion,
      showFeedback: s.showFeedback,
      showScoreDuringExam: s.showScoreDuringExam,
      lockAfterSubmit: s.lockAfterSubmit,
    },
    questions,
  };
}
