// Instructor-only views. These include validator details, instructor-only
// grading detail, command history and filesystem snapshots, so the server
// sends them only to an authenticated instructor.

import type { AnswerKey, AttemptEndReason, AttemptStatus, ExamType, ScoreView, ValidationSpec, ValidatorType } from './exam.js';

/** Response body of GET /api/instructor/me. */
export interface InstructorStatus {
  /** false when no instructor account exists (INSTRUCTOR_PASSWORD was never set). */
  enabled: boolean;
  authenticated: boolean;
  /** Who is signed in. */
  me: InstructorMe | null;
}

export interface InstructorMe {
  id: string;
  username: string;
  /** Shown to students next to this professor's tests. */
  name: string;
  /** May add professors, reset passwords and disable accounts. */
  isAdmin: boolean;
}

/** One row of the administrator's Professors page. */
export interface InstructorAccountSummary extends InstructorMe {
  active: boolean;
  testCount: number;
}

export const ACCOUNT_LIMITS = {
  usernameMin: 3,
  usernameMax: 40,
  nameMax: 80,
  passwordMin: 10,
  passwordMax: 200,
} as const;

const USERNAME = /^[A-Za-z0-9._-]+$/;

export type AccountFieldsCheck = { ok: true; value: { username: string; name: string } } | { ok: false; errors: string[] };

export function validateAccountFields(username: unknown, name: unknown): AccountFieldsCheck {
  const L = ACCOUNT_LIMITS;
  const u = typeof username === 'string' ? username.trim() : '';
  const n = typeof name === 'string' ? name.trim() : '';
  const errors: string[] = [];
  if (!n || n.length > L.nameMax) errors.push(`A name is required (at most ${L.nameMax} characters).`);
  if (u.length < L.usernameMin || u.length > L.usernameMax || !USERNAME.test(u)) {
    errors.push(`A username needs ${L.usernameMin} to ${L.usernameMax} letters, numbers, dots, dashes or underscores.`);
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: { username: u, name: n } };
}

/** The problem with a new password, or null if it's fine. */
export function validatePassword(password: unknown): string | null {
  const L = ACCOUNT_LIMITS;
  if (typeof password !== 'string' || password.length < L.passwordMin) return `A password needs at least ${L.passwordMin} characters.`;
  if (password.length > L.passwordMax) return `A password can have at most ${L.passwordMax} characters.`;
  return null;
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
  /** Set while the test is locked because the student left the screen. */
  lockedAt: string | null;
  lockReason: string | null;
  /** How many times the student left the test screen. */
  timesLeft: number;
  examType: ExamType;
}

/** A time the student left the test screen, or an unlock. */
export interface IntegrityEvent {
  type: 'left' | 'unlocked';
  reason: string;
  at: string;
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
  /** Not fully correct, but earned partial credit. */
  partial: boolean;
  /** What automatic grading says, ignoring any change by the instructor. */
  autoPassed: boolean;
  /** The instructor's decision (null = the automatic grade stands). */
  override: boolean | null;
  /** Written tests: the correct answer and what the student answered. */
  answerKey: AnswerKey | null;
  studentAnswer: string | null;
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
  /** Every time the student left the test screen, and every unlock. */
  integrityEvents: IntegrityEvent[];
  snapshot: FsSnapshotView | null;
}
