// Instructor-only views. These include validator details, instructor-only
// grading detail, command history and filesystem snapshots, so the server
// sends them only to an authenticated instructor.

import type { AttemptEndReason, AttemptStatus, ScoreView, ValidationSpec, ValidatorType } from './exam.js';

/** Response body of GET /api/instructor/me. */
export interface InstructorStatus {
  /** false when the server has no INSTRUCTOR_PASSWORD configured. */
  enabled: boolean;
  authenticated: boolean;
}

export interface AttemptSummary {
  id: string;
  /** Self-reported on the start screen (null for attempts from before it existed). */
  studentName: string | null;
  className: string | null;
  examId: string;
  examTitle: string;
  status: AttemptStatus;
  endReason: AttemptEndReason | null;
  startedAt: string;
  completedAt: string | null;
  score: ScoreView;
  percentage: number;
  submissionCount: number;
  commandCount: number;
  flaggedCommandCount: number;
}

export interface InstructorRuleResult {
  type: ValidatorType;
  passed: boolean;
  message: string;
  /** What the grader actually observed. Never shown to students. */
  detail?: string;
}

export interface InstructorSubmission {
  attemptNumber: number;
  submittedAt: string;
  passed: boolean;
  pointsAwarded: number;
  maxPoints: number;
  rules: InstructorRuleResult[];
}

export interface InstructorCommand {
  seq: number;
  executedAt: string;
  questionId: string | null;
  cwd: string;
  command: string;
  exitCode: number | null;
  flags: string[];
}

export interface InstructorQuestionDetail {
  questionId: string;
  number: number;
  title: string;
  text: string;
  maxPoints: number;
  pointsAwarded: number;
  passed: boolean;
  validation: ValidationSpec;
  /** Total time this question was the open one. */
  timeSpentSeconds: number;
  submissions: InstructorSubmission[];
  commands: InstructorCommand[];
}

export interface FsEntry {
  type: 'file' | 'directory' | 'symlink' | 'other';
  /** Octal permissions, e.g. "640". */
  mode: string;
  owner: string;
  group: string;
  size: number;
  path: string;
  /** Symlink target, if a symlink. */
  target?: string;
}

/** The student's files at the moment the exam ended. */
export interface FsSnapshotView {
  takenAt: string;
  roots: string[];
  entries: FsEntry[];
  /** Contents of small text files. */
  files: Array<{ path: string; content: string; truncated: boolean }>;
  /** true if the listing was cut off at the entry limit. */
  truncated: boolean;
}

/** Response body of GET /api/instructor/attempts/:id. */
export interface AttemptDetail {
  summary: AttemptSummary;
  questions: InstructorQuestionDetail[];
  /** Commands run before any question was recorded as open. */
  unassignedCommands: InstructorCommand[];
  snapshot: FsSnapshotView | null;
}
