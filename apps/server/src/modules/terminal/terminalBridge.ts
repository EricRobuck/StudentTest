import { WebSocket, type RawData } from 'ws';
import {
  TERMINAL_CLOSE,
  TERMINAL_LIMITS,
  type TerminalClientMessage,
  type TerminalServerMessage,
} from '@linuxlab/shared';
import type { ContainerRuntime, ShellHandle } from '../containers/index.js';
import type { ExamSession } from '../sessions/sessionManager.js';

export interface BridgeConfig {
  replayBufferBytes: number;
  maxBufferedBytes: number;
}

const MAX_RESTARTS_PER_MINUTE = 5;

/**
 * Connects one exam session's Bash shell to (at most) one browser WebSocket.
 *
 * The shell outlives the WebSocket: when the browser refreshes or the network
 * blips, the shell keeps running, recent output is kept in a replay buffer,
 * and the next WebSocket is attached to the same shell (same cwd, same state).
 */
export class TerminalBridge {
  private shell: ShellHandle | undefined;
  private shellStarting: Promise<void> | undefined;
  private socket: WebSocket | undefined;
  private size = { cols: 80, rows: 24 };
  private readonly replay: Buffer[] = [];
  private replayBytes = 0;
  private readonly restartTimes: number[] = [];
  private drainTimer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(
    private readonly session: ExamSession,
    private readonly runtime: ContainerRuntime,
    private readonly cfg: BridgeConfig,
    private readonly onActivity: () => void,
  ) {}

  get isAttached(): boolean {
    return this.socket !== undefined;
  }

  attach(ws: WebSocket): void {
    if (this.closed) {
      ws.close(TERMINAL_CLOSE.ENDED, 'Session ended');
      return;
    }
    // One live terminal per session: a second tab takes over from the first.
    if (this.socket && this.socket !== ws) {
      this.socket.close(TERMINAL_CLOSE.REPLACED, 'Opened in another window');
    }
    const resumed = this.replayBytes > 0 || this.shell !== undefined;
    this.socket = ws;
    this.onActivity();

    this.send({ type: 'attached', sessionId: this.session.id, resumed });
    if (this.replayBytes > 0) ws.send(Buffer.concat(this.replay), { binary: true });

    ws.on('message', (data, isBinary) => this.handleMessage(data, isBinary));
    ws.on('close', () => {
      if (this.socket !== ws) return;
      this.socket = undefined;
      this.onActivity();
      // Never leave the shell paused with nobody to drain it.
      this.stopDrainWait();
      this.shell?.resume();
    });

    void this.ensureShell();
  }

  /** Ends the terminal for good (session over). */
  close(code: number, reason: string): void {
    this.closed = true;
    this.stopDrainWait();
    this.socket?.close(code, reason);
    this.socket = undefined;
    this.shell?.close();
    this.shell = undefined;
  }

  private handleMessage(data: RawData, isBinary: boolean): void {
    const bytes = toBuffer(data);
    if (isBinary) {
      // Keystrokes / paste. Phase 8 hooks command logging in here.
      this.shell?.write(bytes);
      this.onActivity();
      return;
    }
    const msg = parseClientMessage(bytes.toString('utf8'));
    if (msg?.type === 'resize') {
      this.size = { cols: msg.cols, rows: msg.rows };
      void this.shell?.resize(msg.cols, msg.rows);
    }
  }

  private async ensureShell(): Promise<void> {
    if (this.shell || this.shellStarting || this.closed) return;
    this.shellStarting = (async () => {
      try {
        const shell = await this.runtime.attachShell(this.session.containerId, this.size);
        if (this.closed) {
          shell.close();
          return;
        }
        this.shell = shell;
        shell.onData((chunk) => this.handleOutput(chunk));
        shell.onExit(() => void this.handleShellExit(shell));
        // The browser usually sends its real size while the shell is still
        // starting; apply whatever the latest size is now.
        void shell.resize(this.size.cols, this.size.rows);
      } catch (err) {
        console.warn(`[terminal] could not start shell for ${this.session.id}:`, err);
        this.send({ type: 'error', code: 'SHELL_FAILED', message: 'Could not start the Linux shell.' });
      } finally {
        this.shellStarting = undefined;
      }
    })();
    await this.shellStarting;
  }

  private handleOutput(chunk: Buffer): void {
    this.replay.push(chunk);
    this.replayBytes += chunk.length;
    while (this.replayBytes > this.cfg.replayBufferBytes && this.replay.length > 1) {
      this.replayBytes -= this.replay.shift()!.length;
    }

    const ws = this.socket;
    if (ws?.readyState !== WebSocket.OPEN) return;
    ws.send(chunk, { binary: true });

    // Backpressure: if the browser can't keep up (e.g. `yes` or `cat` of a huge
    // file), stop reading from the shell until the socket drains.
    if (ws.bufferedAmount > this.cfg.maxBufferedBytes) {
      this.shell?.pause();
      this.waitForDrain(ws);
    }
  }

  private waitForDrain(ws: WebSocket): void {
    if (this.drainTimer) return;
    this.drainTimer = setInterval(() => {
      if (this.socket !== ws || ws.bufferedAmount < this.cfg.maxBufferedBytes / 4) {
        this.stopDrainWait();
        this.shell?.resume();
      }
    }, 50);
  }

  private stopDrainWait(): void {
    if (this.drainTimer) clearInterval(this.drainTimer);
    this.drainTimer = undefined;
  }

  private async handleShellExit(shell: ShellHandle): Promise<void> {
    if (this.shell !== shell) return;
    this.shell = undefined;
    // Nobody watching: a new shell is started on the next attach instead.
    if (this.closed || !this.socket) return;

    if (!(await this.runtime.isRunning(this.session.containerId).catch(() => false))) {
      this.send({
        type: 'error',
        code: 'ENVIRONMENT_ENDED',
        message: 'Your Linux environment has ended. Refresh the page to start a new one.',
      });
      return;
    }

    // Student typed `exit` (or bash crashed): give them a fresh shell, but
    // don't spin forever if something is badly wrong.
    const now = Date.now();
    while (this.restartTimes.length && now - this.restartTimes[0]! > 60_000) this.restartTimes.shift();
    if (this.restartTimes.length >= MAX_RESTARTS_PER_MINUTE) {
      this.send({ type: 'error', code: 'SHELL_FAILED', message: 'The shell keeps exiting. Refresh to try again.' });
      return;
    }
    this.restartTimes.push(now);
    this.send({ type: 'shell-restarted' });
    await this.ensureShell();
  }

  private send(msg: TerminalServerMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(msg));
  }
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/** Strictly validates a control message. Anything unexpected is ignored. */
function parseClientMessage(text: string): TerminalClientMessage | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const msg = value as Record<string, unknown>;
  if (
    msg.type === 'resize' &&
    isIntInRange(msg.cols, 1, TERMINAL_LIMITS.maxCols) &&
    isIntInRange(msg.rows, 1, TERMINAL_LIMITS.maxRows)
  ) {
    return { type: 'resize', cols: msg.cols, rows: msg.rows };
  }
  return undefined;
}

function isIntInRange(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}
