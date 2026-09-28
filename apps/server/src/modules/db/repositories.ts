import type { AttemptEndReason, AttemptStatus } from '@linuxlab/shared';

// Storage interfaces. Services depend only on these; sqliteRepositories.ts
// implements them today and a PostgreSQL implementation can replace it.
// Methods are async even though node:sqlite is synchronous, so the swap
// does not ripple through the callers.

export interface AttemptRecord {
  id: string;
  examId: string;
  studentId: string | null;
  status: AttemptStatus;
  endReason: AttemptEndReason | null;
  startedAt: string;
  deadlineAt: string | null;
  completedAt: string | null;
  currentQuestionId: string | null;
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
  /** Marks the attempt completed; returns false if it was already completed. */
  complete(id: string, reason: AttemptEndReason, completedAt: string): Promise<boolean>;
  /** In-progress attempts whose deadline has passed. */
  listExpired(now: string): Promise<AttemptRecord[]>;
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
}
