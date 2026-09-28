import type { StudentExam, StudentQuestion } from '@linuxlab/shared';
import { sampleExam } from './sampleExam.js';
import type { ExamDefinition } from './types.js';

/** The exam students currently take. Phase 7 replaces this with assignments from the database. */
export function getActiveExam(): ExamDefinition {
  return sampleExam;
}

/**
 * The only way exam data reaches a student. Builds the view field by field
 * (an allow-list), so adding a new secret field to QuestionDefinition can
 * never leak it by accident.
 */
export function toStudentExam(exam: ExamDefinition): StudentExam {
  const ordered = [...exam.questions].sort((a, b) => a.order - b.order);
  const questions: StudentQuestion[] = ordered.map((q, index) => ({
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
  return {
    id: exam.id,
    title: exam.title,
    mode: exam.settings.mode,
    totalPoints: questions.reduce((sum, q) => sum + q.points, 0),
    questions,
  };
}
