import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AttemptStatus, StudentInfo } from '@linuxlab/shared';
import type { AttemptService } from '../attempts/attemptService.js';
import { ContainerError, type ContainerRuntime } from '../containers/index.js';
import type { AttemptRecord, Repositories, SessionRecord } from '../db/index.js';
import { applySetup, examSetupSteps } from '../exams/setupRunner.js';
import type { ExamDefinition } from '../exams/types.js';

// A session is one browser's link to one exam attempt and, while the exam is
// in progress, one student container. The browser holds a random token in an
// httpOnly cookie; only its SHA-256 hash is stored.
//
// Sessions live in the database, so a server restart does not lose them:
// the student reconnects to the same attempt and the same container.

export interface ExamSession {
  id: string;
  attemptId: string;
  containerId: string | null;
  containerName: string | null;
}

export type EnvironmentEndReason = 'idle' | 'environment-lost' | 'exam-over' | 'attempt-deleted';

/** The chosen exam is not open (disabled, deleted, or no approved questions). */
export class ExamNotOpenError extends Error {
  constructor() {
    super('That test is not open right now. Please choose another test or ask your instructor.');
  }
}

export interface SessionResult {
  session: ExamSession;
  token: string;
  resumed: boolean;
  attemptStatus: AttemptStatus;
  environmentReset: boolean;
  student: StudentInfo;
}

/** Don't write last-activity to the database more often than this per session. */
const TOUCH_INTERVAL_MS = 30_000;

export class SessionManager {
  private readonly envEndedListeners: Array<(sessionId: string, reason: EnvironmentEndReason) => void> = [];
  private readonly lastTouchWrite = new Map<string, number>();
  private readonly examOverHooks: Array<(attemptId: string, sessionId: string, containerId: string) => Promise<void>> = [];

  constructor(
    private readonly runtime: ContainerRuntime,
    private readonly repos: Repositories,
    private readonly attempts: AttemptService,
    private readonly openExam: (examId: string) => ExamDefinition | undefined,
    private readonly examFor: (attempt: AttemptRecord) => ExamDefinition | undefined,
  ) {
    // When an exam ends (finish or time up), its Linux environments go away.
    attempts.onCompleted((attemptId) => void this.endEnvironmentsForAttempt(attemptId));
  }

  async findByToken(token: string): Promise<ExamSession | undefined> {
    const record = await this.repos.sessions.findByTokenHash(hashToken(token));
    return record ? toSession(record) : undefined;
  }

  /**
   * Resumes the caller's session. Returns undefined if there is none (the
   * browser should show the start screen). For an in-progress attempt whose
   * container has gone (idle timeout, crash), a fresh container is created
   * and environmentReset is reported.
   */
  async resume(token: string | undefined): Promise<SessionResult | undefined> {
    const existing = token ? await this.repos.sessions.findByTokenHash(hashToken(token)) : undefined;
    if (!existing || !token) return undefined;
    const attempt = await this.attempts.get(existing.attemptId);
    if (!attempt) return undefined;
    const student = { name: attempt.studentName ?? '', className: attempt.className ?? '' };
    const base = { token, resumed: true, student };

    if (attempt.status === 'completed') {
      return { ...base, session: toSession(existing), attemptStatus: 'completed', environmentReset: false };
    }
    if (existing.containerId && (await this.runtime.isRunning(existing.containerId))) {
      await this.touch(existing.id, true);
      return { ...base, session: toSession(existing), attemptStatus: 'in_progress', environmentReset: false };
    }
    if (existing.containerId) await this.endEnvironment(existing.id, 'environment-lost');
    const container = await this.createPreparedContainer(existing.id, this.examFor(attempt));
    await this.repos.sessions.setContainer(existing.id, container.containerId, container.name);
    await this.touch(existing.id, true);
    console.log(`[sessions] new environment for session ${existing.id} → ${container.name}`);
    const session = { ...toSession(existing), containerId: container.containerId, containerName: container.name };
    return { ...base, session, attemptStatus: 'in_progress', environmentReset: true };
  }

  /** The student of the caller's current attempt (e.g. to keep it for a practice retake). */
  async studentOf(attemptId: string): Promise<StudentInfo | undefined> {
    const attempt = await this.attempts.get(attemptId);
    return attempt?.studentName && attempt.className ? { name: attempt.studentName, className: attempt.className } : undefined;
  }

  /**
   * For an attempt that began before names were asked: record the student
   * on it (only if it has none yet) and return the updated session.
   */
  async nameUnnamedAttempt(token: string, student: StudentInfo): Promise<SessionResult | undefined> {
    const current = await this.resume(token);
    if (!current || current.student.name) return current;
    await this.repos.attempts.setStudent(current.session.attemptId, student.name, student.className);
    return { ...current, student };
  }

  /** Starts a new attempt on an open exam, with a new session (cookie token) and container. */
  async start(student: StudentInfo, examId: string): Promise<SessionResult> {
    const exam = this.openExam(examId);
    if (!exam) throw new ExamNotOpenError();
    const newToken = randomBytes(32).toString('base64url');
    const id = randomUUID();
    // Prepare the environment first, so a failure leaves no half-started attempt.
    const container = await this.createPreparedContainer(id, exam);
    let attempt;
    try {
      attempt = await this.attempts.start(exam, student);
    } catch (err) {
      await this.runtime.destroy(container.containerId).catch(() => undefined);
      throw err;
    }
    const now = new Date().toISOString();
    const record: SessionRecord = {
      id,
      tokenHash: hashToken(newToken),
      attemptId: attempt.id,
      containerId: container.containerId,
      containerName: container.name,
      createdAt: now,
      lastActiveAt: now,
    };
    await this.repos.sessions.create(record);
    console.log(`[sessions] created session ${id} (attempt ${attempt.id}) → ${container.name}`);
    return {
      session: toSession(record),
      token: newToken,
      resumed: false,
      attemptStatus: 'in_progress',
      environmentReset: false,
      student,
    };
  }

  /** A new container with the exam's setup applied (files to find, etc.). */
  private async createPreparedContainer(sessionId: string, exam: ExamDefinition | undefined) {
    const container = await this.runtime.createSessionContainer(sessionId, { allowSudo: exam?.settings.allowSudo === true });
    try {
      if (exam) await applySetup(this.runtime, container.containerId, examSetupSteps(exam.questions));
    } catch (err) {
      await this.runtime.destroy(container.containerId).catch(() => undefined);
      throw new ContainerError('DOCKER_ERROR', `Could not prepare the exam environment: ${String(err)}`, { cause: err });
    }
    return container;
  }

  /** Records activity. Throttled so keystrokes don't hammer the database. */
  async touch(sessionId: string, force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - (this.lastTouchWrite.get(sessionId) ?? 0) < TOUCH_INTERVAL_MS) return;
    this.lastTouchWrite.set(sessionId, now);
    await this.repos.sessions.touch(sessionId, new Date(now).toISOString());
  }

  /** Sessions (browser tabs) belonging to an attempt. */
  async sessionIdsOfAttempt(attemptId: string): Promise<string[]> {
    return (await this.repos.sessions.findByAttempt(attemptId)).map((s) => s.id);
  }

  /** Container ids that belong to a live session (everything else is an orphan). */
  async ownedContainerIds(): Promise<Set<string>> {
    const sessions = await this.repos.sessions.listWithContainer();
    return new Set(sessions.map((s) => s.containerId!));
  }

  onEnvironmentEnded(listener: (sessionId: string, reason: EnvironmentEndReason) => void): void {
    this.envEndedListeners.push(listener);
  }

  /** Removes a session's container. The session and attempt remain. */
  async endEnvironment(sessionId: string, reason: EnvironmentEndReason): Promise<void> {
    const s = await this.repos.sessions.get(sessionId);
    if (!s?.containerId) return;
    await this.repos.sessions.setContainer(sessionId, null, null);
    for (const listener of this.envEndedListeners) listener(sessionId, reason);
    await this.runtime.destroy(s.containerId);
    console.log(`[sessions] removed environment of session ${sessionId} (${reason})`);
  }

  /** Runs just before a finished exam's container is removed (e.g. to snapshot its files). */
  beforeExamEnvironmentRemoved(hook: (attemptId: string, sessionId: string, containerId: string) => Promise<void>): void {
    this.examOverHooks.push(hook);
  }

  private async endEnvironmentsForAttempt(attemptId: string): Promise<void> {
    for (const s of await this.repos.sessions.findByAttempt(attemptId)) {
      try {
        if (s.containerId) {
          for (const hook of this.examOverHooks) await hook(attemptId, s.id, s.containerId);
        }
        await this.endEnvironment(s.id, 'exam-over');
      } catch (err) {
        console.warn(`[sessions] could not remove environment of ${s.id}:`, err);
      }
    }
  }

  /**
   * Periodically: complete attempts whose time is up, and remove containers
   * of sessions with no browser attached for longer than idleMs.
   */
  startSweep(opts: { idleMs: number; intervalMs: number; isAttached: (sessionId: string) => boolean }): () => void {
    const sweep = async () => {
      await this.attempts.expireOverdue();
      const now = Date.now();
      for (const s of await this.repos.sessions.listWithContainer()) {
        if (opts.isAttached(s.id)) {
          await this.touch(s.id);
        } else if (now - Date.parse(s.lastActiveAt) > opts.idleMs) {
          await this.endEnvironment(s.id, 'idle');
        }
      }
    };
    const run = () => sweep().catch((err: unknown) => console.warn('[sessions] sweep failed:', err));
    const timer = setInterval(() => void run(), opts.intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }
}

function toSession(r: SessionRecord): ExamSession {
  return { id: r.id, attemptId: r.attemptId, containerId: r.containerId, containerName: r.containerName };
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
