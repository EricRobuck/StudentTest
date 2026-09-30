import type {
  AttemptEndReason,
  AttemptStatus,
  ExamSettings,
  QuestionContent,
  QuestionSource,
  QuestionStatus,
  QuestionVerification,
} from '@linuxlab/shared';

// Storage interfaces. Services depend only on these; sqliteRepositories.ts
// implements them today and a PostgreSQL implementation can replace it.
// Methods are async even though node:sqlite is synchronous, so the swap
// does not ripple through the callers.

export interface AttemptRecord {
  id: string;
  examId: string;
  /** Reserved for real student accounts. */
  studentId: string | null;
  /** Self-reported on the start screen. */
  studentName: string | null;
  className: string | null;
  status: AttemptStatus;
  endReason: AttemptEndReason | null;
  startedAt: string;
  deadlineAt: string | null;
  completedAt: string | null;
  currentQuestionId: string | null;
  /** The exam as it was when this attempt started (null for older attempts). */
  examSnapshot: unknown | null;
  /** Set when the student left the test screen; cleared when the instructor unlocks. */
  lockedAt: string | null;
  lockReason: string | null;
}

export interface IntegrityEventRecord {
  type: 'left' | 'unlocked';
  reason: string;
  at: string;
}

export interface ExamRecord {
  id: string;
  title: string;
  description: string | null;
  settings: ExamSettings;
  /** Offered to students on the start screen (if it has approved questions). */
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ExamQuestionRecord {
  id: string;
  examId: string;
  position: number;
  status: QuestionStatus;
  source: QuestionSource;
  content: QuestionContent;
  verification: QuestionVerification;
  createdAt: string;
  updatedAt: string;
}

export interface ExamRepository {
  list(): Promise<ExamRecord[]>;
  get(id: string): Promise<ExamRecord | undefined>;
  save(exam: ExamRecord): Promise<void>;
  delete(id: string): Promise<void>;
  questions(examId: string): Promise<ExamQuestionRecord[]>;
  allQuestions(): Promise<ExamQuestionRecord[]>;
  getQuestion(id: string): Promise<ExamQuestionRecord | undefined>;
  saveQuestion(q: ExamQuestionRecord): Promise<void>;
  deleteQuestion(id: string): Promise<void>;
  /** Sets positions 1..n in the given order. */
  reorder(examId: string, questionIds: string[]): Promise<void>;
  getSetting(key: string): Promise<string | undefined>;
  setSetting(key: string, value: string): Promise<void>;
}

export interface AttemptQuestionRecord {
  questionId: string;
  position: number;
  maxPoints: number;
  variables: Record<string, string>;
}

export interface SessionRecord {
  id: string;
  tokenHash: string;
  attemptId: string;
  containerId: string | null;
  containerName: string | null;
  createdAt: string;
  lastActiveAt: string;
}

export interface SubmissionRecord {
  id: string;
  attemptId: string;
  questionId: string;
  attemptNumber: number;
  passed: boolean;
  score: number;
  pointsAwarded: number;
  maxPoints: number;
  /** Full rule results, including instructor-only detail. */
  ruleResults: unknown;
  submittedAt: string;
}

export interface CommandLogRecord {
  id: string;
  attemptId: string;
  sessionId: string;
  questionId: string | null;
  seq: number;
  command: string;
  cwd: string;
  exitCode: number | null;
  flags: string[];
  executedAt: string;
}

export interface AttemptRepository {
  create(attempt: AttemptRecord, questions: AttemptQuestionRecord[]): Promise<void>;
  get(id: string): Promise<AttemptRecord | undefined>;
  questions(attemptId: string): Promise<AttemptQuestionRecord[]>;
  setCurrentQuestion(id: string, questionId: string): Promise<void>;
  /** Locks the attempt (if not already locked) and logs the event. Returns true if it was newly locked. */
  lock(id: string, reason: string, at: string): Promise<boolean>;
  /** Unlocks and logs the event. Returns true if it was locked. */
  unlock(id: string, by: string, at: string): Promise<boolean>;
  integrityEvents(id: string): Promise<IntegrityEventRecord[]>;
  /** Permanently removes an attempt and everything recorded for it. False if it didn't exist. */
  delete(id: string): Promise<boolean>;
  /** Records who is taking an attempt that started without a name. */
  setStudent(id: string, studentName: string, className: string): Promise<void>;
  /** Marks the attempt completed; returns false if it was already completed. */
  complete(id: string, reason: AttemptEndReason, completedAt: string): Promise<boolean>;
  /** In-progress attempts whose deadline has passed. */
  listExpired(now: string): Promise<AttemptRecord[]>;
  /** All attempts, newest first. */
  listAll(): Promise<AttemptRecord[]>;
  /** Records that a question became the open one. */
  addVisit(attemptId: string, questionId: string, at: string): Promise<void>;
  visits(attemptId: string): Promise<Array<{ questionId: string; enteredAt: string }>>;
}

export interface SnapshotRepository {
  save(attemptId: string, sessionId: string, takenAt: string, data: unknown): Promise<void>;
  /** Snapshots of an attempt, oldest first. */
  forAttempt(attemptId: string): Promise<Array<{ sessionId: string; takenAt: string; data: unknown }>>;
}

export interface SessionRepository {
  create(session: SessionRecord): Promise<void>;
  findByTokenHash(tokenHash: string): Promise<SessionRecord | undefined>;
  get(id: string): Promise<SessionRecord | undefined>;
  findByAttempt(attemptId: string): Promise<SessionRecord[]>;
  setContainer(id: string, containerId: string | null, containerName: string | null): Promise<void>;
  touch(id: string, at: string): Promise<void>;
  /** Sessions that currently have a container. */
  listWithContainer(): Promise<SessionRecord[]>;
}

export interface SubmissionRepository {
  /** Inserts with the next attempt number for (attempt, question); returns that number. */
  add(submission: Omit<SubmissionRecord, 'attemptNumber'>): Promise<number>;
  listForAttempt(attemptId: string): Promise<SubmissionRecord[]>;
}

export interface CommandLogRepository {
  /** Appends with the next sequence number for the attempt; returns that number. */
  add(entry: Omit<CommandLogRecord, 'seq'>): Promise<number>;
  listForAttempt(attemptId: string): Promise<CommandLogRecord[]>;
}

export interface Repositories {
  attempts: AttemptRepository;
  sessions: SessionRepository;
  submissions: SubmissionRepository;
  commands: CommandLogRepository;
  snapshots: SnapshotRepository;
  exams: ExamRepository;
}
