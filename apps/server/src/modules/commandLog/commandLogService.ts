import { randomUUID } from 'node:crypto';
import type { Repositories } from '../db/index.js';
import type { LoggedCommand } from '../terminal/commandMarkers.js';

// Commands that interfere with command logging itself. They are still
// logged, but flagged so an instructor notices.
const TAMPERING =
  /PROMPT_COMMAND|\bPS0\b|__ll_|__LL_|HISTCONTROL|HISTIGNORE|HISTFILE|set\s+\+o\s+history|\bhistory\s+-[cdw]|\benable\s+-n|command-hook|--norc|--noprofile/;

export interface CommandLogLimits {
  /** Commands accepted in a burst… */
  commandLogBurst: number;
  /** …then refilled at this rate. */
  commandLogPerSecond: number;
  /** Hard cap per session (a student can forge markers by printing them). */
  commandLogMaxPerAttempt: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
  dropped: number;
  stored: number;
}

/** Stores the commands students run (requirements §14). */
export class CommandLogService {
  // One queue: commands are stored strictly in the order they arrive.
  private queue: Promise<void> = Promise.resolve();
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly repos: Repositories,
    private readonly limits: CommandLogLimits,
  ) {}

  record(sessionId: string, cmd: LoggedCommand): void {
    // A person types a few commands a minute. Anything much faster is a
    // student printing fake log markers to flood the database: drop the
    // excess and leave one flagged entry saying how many were dropped.
    const bucket = this.bucketFor(sessionId);
    if (bucket.tokens < 1 || bucket.stored >= this.limits.commandLogMaxPerAttempt) {
      bucket.dropped++;
      return;
    }
    bucket.tokens--;
    const dropped = bucket.dropped;
    bucket.dropped = 0;
    bucket.stored += dropped > 0 ? 2 : 1;

    this.queue = this.queue
      .then(async () => {
        if (dropped > 0) await this.store(sessionId, floodNotice(dropped, cmd.startedAt));
        await this.store(sessionId, cmd);
      })
      .catch((err: unknown) => console.warn(`[commands] could not log command for ${sessionId}:`, err));
  }

  private bucketFor(sessionId: string): Bucket {
    const now = Date.now();
    let b = this.buckets.get(sessionId);
    if (!b) {
      b = { tokens: this.limits.commandLogBurst, updatedAt: now, dropped: 0, stored: 0 };
      this.buckets.set(sessionId, b);
    }
    const refill = ((now - b.updatedAt) / 1000) * this.limits.commandLogPerSecond;
    b.tokens = Math.min(this.limits.commandLogBurst, b.tokens + refill);
    b.updatedAt = now;
    return b;
  }

  private async store(sessionId: string, cmd: LoggedCommand & { flags?: string[] }): Promise<void> {
    const session = await this.repos.sessions.get(sessionId);
    if (!session) return;
    const attempt = await this.repos.attempts.get(session.attemptId);
    if (!attempt || attempt.status !== 'in_progress') return;
    await this.repos.commands.add({
      id: randomUUID(),
      attemptId: attempt.id,
      sessionId,
      questionId: attempt.currentQuestionId,
      command: cmd.command,
      cwd: cmd.cwd,
      exitCode: cmd.exitCode,
      flags: cmd.flags ?? (TAMPERING.test(cmd.command) ? ['logging-tamper'] : []),
      executedAt: cmd.startedAt, // server clock when the command started
    });
  }

  /** Waits until everything received so far is stored (tests, shutdown). */
  flush(): Promise<void> {
    return this.queue;
  }
}

function floodNotice(dropped: number, at: string): LoggedCommand & { flags: string[] } {
  return {
    command: `[${dropped} command report(s) dropped: arriving faster than anyone can type]`,
    cwd: '',
    exitCode: null,
    startedAt: at,
    flags: ['log-flood'],
  };
}
