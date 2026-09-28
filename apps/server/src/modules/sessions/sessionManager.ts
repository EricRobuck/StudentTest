import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { ContainerRuntime } from '../containers/index.js';

// An exam session owns exactly one student container. The browser holds a
// random token in an httpOnly cookie; only its SHA-256 hash is kept here, so
// the token cannot be read back out of server memory or logs.
//
// Sessions live in memory for now. Phase 7 moves them into the database so
// they survive a server restart (and adds the student/exam they belong to).

export interface ExamSession {
  id: string;
  containerId: string;
  containerName: string;
  createdAt: Date;
  /** Last time a browser was attached or sent input (ms since epoch). */
  lastActiveAt: number;
}

export type SessionEndReason = 'idle' | 'environment-ended' | 'shutdown';

export class SessionManager {
  private readonly sessions = new Map<string, ExamSession>();
  private readonly sessionIdByTokenHash = new Map<string, string>();
  private readonly endListeners: Array<(session: ExamSession, reason: SessionEndReason) => void> = [];

  constructor(private readonly runtime: ContainerRuntime) {}

  findByToken(token: string): ExamSession | undefined {
    const id = this.sessionIdByTokenHash.get(hashToken(token));
    return id ? this.sessions.get(id) : undefined;
  }

  /**
   * Returns the caller's existing session if its container is still running,
   * otherwise creates a new session with a fresh container.
   */
  async resumeOrCreate(
    token: string | undefined,
  ): Promise<{ session: ExamSession; token: string; resumed: boolean }> {
    const existing = token ? this.findByToken(token) : undefined;
    if (existing && token) {
      if (await this.runtime.isRunning(existing.containerId)) {
        this.touch(existing.id);
        return { session: existing, token, resumed: true };
      }
      await this.end(existing.id, 'environment-ended');
    }

    const newToken = randomBytes(32).toString('base64url');
    const id = randomUUID();
    const container = await this.runtime.createSessionContainer(id);
    const session: ExamSession = {
      id,
      containerId: container.containerId,
      containerName: container.name,
      createdAt: new Date(),
      lastActiveAt: Date.now(),
    };
    this.sessions.set(id, session);
    this.sessionIdByTokenHash.set(hashToken(newToken), id);
    console.log(`[sessions] created session ${id} → ${container.name}`);
    return { session, token: newToken, resumed: false };
  }

  touch(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) s.lastActiveAt = Date.now();
  }

  ownsContainer(containerId: string): boolean {
    for (const s of this.sessions.values()) if (s.containerId === containerId) return true;
    return false;
  }

  onEnded(listener: (session: ExamSession, reason: SessionEndReason) => void): void {
    this.endListeners.push(listener);
  }

  /** Ends a session and removes its container. */
  async end(sessionId: string, reason: SessionEndReason): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    for (const [hash, id] of this.sessionIdByTokenHash) {
      if (id === sessionId) this.sessionIdByTokenHash.delete(hash);
    }
    for (const listener of this.endListeners) listener(session, reason);
    await this.runtime.destroy(session.containerId);
    console.log(`[sessions] ended session ${sessionId} (${reason})`);
  }

  /**
   * Periodically ends sessions that have had no browser attached for longer
   * than idleMs. Returns a stop function.
   */
  startIdleSweep(opts: {
    idleMs: number;
    intervalMs: number;
    isAttached: (sessionId: string) => boolean;
  }): () => void {
    const sweep = async () => {
      const now = Date.now();
      for (const s of [...this.sessions.values()]) {
        if (opts.isAttached(s.id)) {
          s.lastActiveAt = now;
        } else if (now - s.lastActiveAt > opts.idleMs) {
          await this.end(s.id, 'idle').catch((err: unknown) =>
            console.warn(`[sessions] could not end idle session ${s.id}:`, err),
          );
        }
      }
    };
    const timer = setInterval(() => void sweep(), opts.intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
