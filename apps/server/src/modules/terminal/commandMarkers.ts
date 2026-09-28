// Extracts command-log markers (OSC 7337, written by the container's bash
// hook, docker/student-ubuntu/command-hook.sh) from the terminal output
// stream, and removes them so the browser never sees them.
//
// Markers:
//   ESC ] 7337 ; v2 ; cmd ; <history #> ; <base64 cwd> ; <base64 command> BEL   (before it runs)
//   ESC ] 7337 ; v2 ; exit ; <history #> ; <exit status> BEL                     (when it finishes)
//
// Markers can be split across output chunks, so a small carry buffer holds
// an incomplete marker until the rest arrives.

const PREFIX = Buffer.from('\x1b]7337;', 'latin1');
const BEL = 0x07;
/** Anything longer isn't a real marker (commands are capped at 4 KB before base64). */
const MAX_MARKER_BYTES = 16 * 1024;

export interface LoggedCommand {
  command: string;
  cwd: string;
  /** null if the shell never reported one (still running when the shell ended, or logging disturbed). */
  exitCode: number | null;
  /** Server time when the command started. */
  startedAt: string;
}

type MarkerEvent =
  | { kind: 'cmd'; historyNumber: number; cwd: string; command: string }
  | { kind: 'exit'; historyNumber: number; status: number };

/**
 * Turns the marker stream of one shell into completed commands. A command is
 * emitted when its exit marker arrives, or when the next command starts
 * without one. The history number removes duplicates (e.g. a repeated
 * report for the same command).
 */
export class CommandMarkerParser {
  private carry: Buffer = Buffer.alloc(0);
  private pending: LoggedCommand & { historyNumber: number } | undefined;
  private lastHistoryNumber = -1;

  /** Returns the output with markers removed, plus the commands completed so far. */
  push(chunk: Buffer): { output: Buffer; commands: LoggedCommand[] } {
    const { output, events } = this.extract(chunk);
    const commands: LoggedCommand[] = [];
    for (const e of events) {
      if (e.kind === 'cmd') {
        if (e.historyNumber === this.lastHistoryNumber) continue;
        if (this.pending) commands.push(this.takePending(null));
        this.lastHistoryNumber = e.historyNumber;
        this.pending = {
          historyNumber: e.historyNumber,
          command: e.command,
          cwd: e.cwd,
          exitCode: null,
          startedAt: new Date().toISOString(),
        };
      } else if (this.pending?.historyNumber === e.historyNumber) {
        commands.push(this.takePending(e.status));
      }
    }
    return { output, commands };
  }

  /** The command still running when the shell ended, if any. */
  flush(): LoggedCommand[] {
    return this.pending ? [this.takePending(null)] : [];
  }

  private takePending(exitCode: number | null): LoggedCommand {
    const { historyNumber: _, ...cmd } = this.pending!;
    this.pending = undefined;
    return { ...cmd, exitCode };
  }

  private extract(chunk: Buffer): { output: Buffer; events: MarkerEvent[] } {
    let data = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk;
    this.carry = Buffer.alloc(0);
    const out: Buffer[] = [];
    const events: MarkerEvent[] = [];

    for (;;) {
      const start = data.indexOf(PREFIX);
      if (start === -1) {
        // Hold back a trailing partial prefix (e.g. a lone ESC) until the next chunk.
        const keep = partialPrefixLength(data);
        out.push(data.subarray(0, data.length - keep));
        this.carry = Buffer.from(data.subarray(data.length - keep));
        break;
      }
      const end = data.indexOf(BEL, start + PREFIX.length);
      if (end === -1) {
        if (data.length - start > MAX_MARKER_BYTES) {
          // Not a marker after all; pass it through unchanged.
          out.push(data);
        } else {
          out.push(data.subarray(0, start));
          this.carry = Buffer.from(data.subarray(start));
        }
        break;
      }
      out.push(data.subarray(0, start));
      const parsed = parseMarker(data.subarray(start + PREFIX.length, end).toString('latin1'));
      if (parsed) events.push(parsed);
      data = data.subarray(end + 1);
    }

    return { output: out.length === 1 ? out[0]! : Buffer.concat(out), events };
  }
}

function partialPrefixLength(data: Buffer): number {
  for (let k = Math.min(PREFIX.length - 1, data.length); k > 0; k--) {
    if (data.subarray(data.length - k).equals(PREFIX.subarray(0, k))) return k;
  }
  return 0;
}

const NUMBER = /^\d{1,9}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Strictly parses a marker body. Anything malformed is ignored. */
function parseMarker(body: string): MarkerEvent | undefined {
  const parts = body.split(';');
  if (parts[0] !== 'v2') return undefined;

  if (parts[1] === 'cmd' && parts.length === 5) {
    const [, , num, cwd64, cmd64] = parts as [string, string, string, string, string];
    if (!NUMBER.test(num) || !BASE64.test(cwd64) || !BASE64.test(cmd64)) return undefined;
    const command = Buffer.from(cmd64, 'base64').toString('utf8').slice(0, 4096);
    const cwd = Buffer.from(cwd64, 'base64').toString('utf8').slice(0, 4096);
    if (command.trim() === '') return undefined;
    return { kind: 'cmd', historyNumber: Number(num), cwd, command };
  }

  if (parts[1] === 'exit' && parts.length === 4) {
    const [, , num, status] = parts as [string, string, string, string];
    if (!NUMBER.test(num) || !/^\d{1,3}$/.test(status)) return undefined;
    return { kind: 'exit', historyNumber: Number(num), status: Number(status) };
  }
  return undefined;
}
