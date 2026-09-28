import { randomUUID } from 'node:crypto';
import type { Repositories } from '../db/index.js';
import type { LoggedCommand } from '../terminal/commandMarkers.js';

// Commands that interfere with command logging itself. They are still
// logged, but flagged so an instructor notices.
const TAMPERING =
  /PROMPT_COMMAND|\bPS0\b|__ll_|__LL_|HISTCONTROL|HISTIGNORE|HISTFILE|set\s+\+o\s+history|\bhistory\s+-[cdw]|\benable\s+-n|command-hook|--norc|--noprofile/;

/** Stores the commands students run (requirements §14). */
export class CommandLogService {
  // One queue: commands are stored strictly in the order they arrive.
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly repos: Repositories) {}

  record(sessionId: string, cmd: LoggedCommand): void {
    this.queue = this.queue
      .then(() => this.store(sessionId, cmd))
      .catch((err: unknown) => console.warn(`[commands] could not log command for ${sessionId}:`, err));
  }

  private async store(sessionId: string, cmd: LoggedCommand): Promise<void> {
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
      flags: TAMPERING.test(cmd.command) ? ['logging-tamper'] : [],
      executedAt: cmd.startedAt, // server clock when the command started
    });
  }

  /** Waits until everything received so far is stored (tests, shutdown). */
  flush(): Promise<void> {
    return this.queue;
  }
}
