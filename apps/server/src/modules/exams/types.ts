import type { ExamSettings, QuestionContent } from '@linuxlab/shared';

// Server-side exam definitions. These contain the answers (validators and
// model solutions), so they are never sent to students; see toStudentExam()
// for the redacted view.

export type { ExamSettings };

/**
 * Which kind of lab environment runs the question. Only Linux exists today;
 * future lab types (Python, networking, ...) plug in as new values.
 */
export type LabType = 'linux';

export interface QuestionDefinition extends QuestionContent {
  id: string;
  /** Position within the exam, ascending. */
  order: number;
  labType: LabType;
}

/**
 * An exam as students take it: only approved questions, in order. A copy is
 * frozen onto each attempt when it starts, so later edits never change an
 * exam a student is already taking.
 */
export interface ExamDefinition {
  id: string;
  title: string;
  description?: string;
  settings: ExamSettings;
  questions: QuestionDefinition[];
}
