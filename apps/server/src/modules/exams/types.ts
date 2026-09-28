import type { Difficulty, ExamMode, SetupStep, ValidationSpec } from '@linuxlab/shared';

// Server-side exam definitions. These contain the answers (validators), so
// they are never sent to students; see toStudentExam() for the redacted view.
// Phase 7 stores these in the database; the shape stays the same.

/**
 * Which kind of lab environment runs the question. Only Linux exists today;
 * future lab types (Python, networking, ...) plug in as new values.
 */
export type LabType = 'linux';

export interface QuestionDefinition {
  id: string;
  /** Position within the exam, ascending. */
  order: number;
  labType: LabType;
  title: string;
  /** The task. Text inside `backticks` is shown as code. */
  text: string;
  instructions?: string;
  points: number;
  category: string;
  difficulty: Difficulty;
  /** Runs in the container before the question is shown (not used by the sample exam). */
  setup: SetupStep[];
  validation: ValidationSpec;
  hint?: string;
  /** Shown after completion in practice mode (Phase 7). */
  explanation?: string;
}

export interface ExamSettings {
  mode: ExamMode;
  allowHints: boolean;
  /** null = untimed. */
  timeLimitMinutes: number | null;
  /** null = unlimited attempts per question. */
  maxAttemptsPerQuestion: number | null;
  showScoreDuringExam: boolean;
}

export interface ExamDefinition {
  id: string;
  title: string;
  description?: string;
  settings: ExamSettings;
  questions: QuestionDefinition[];
}
