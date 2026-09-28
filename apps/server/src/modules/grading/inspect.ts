import { GradingError, type GradingContext } from './types.js';

// Low-level, read-only probes of the container used by the validators.
//
// Safety rules for everything in this file:
//  - Commands are fixed argv arrays; paths are passed as separate arguments
//    after `--`, never spliced into a shell string.
//  - Paths come from exam definitions (instructors), but are still checked.
//  - Container output is untrusted: size-capped by exec and parsed strictly.

/** Absolute, no NUL/newlines, no `..` segments, reasonable length. */
export function assertSafePath(path: string): void {
  if (
    !path.startsWith('/') ||
    path.length > 4096 ||
    /[\0\n\r]/.test(path) ||
    path.split('/').includes('..')
  ) {
    throw new GradingError(`Invalid path in exam definition: ${JSON.stringify(path)}`);
  }
}

export type FileKind = 'directory' | 'file' | 'symlink' | 'other';

export interface PathInfo {
  kind: FileKind;
  /** Octal permission bits as printed by stat, e.g. "640" or "4755". */
  mode: string;
  owner: string;
  group: string;
}

/**
 * Describes a path WITHOUT following a final symlink (GNU stat's default),
 * so a symlink cannot pass as a real file or directory. Returns null if the
 * path does not exist.
 */
export async function statPath(ctx: GradingContext, path: string): Promise<PathInfo | null> {
  assertSafePath(path);
  const r = await ctx.runtime.exec(ctx.containerId, ['stat', '-c', '%F|%a|%U|%G', '--', path], {
    user: 'root',
    timeoutMs: 5000,
    maxOutputBytes: 4096,
  });
  if (r.timedOut) throw new GradingError('Timed out inspecting the file system');
  if (r.exitCode !== 0) return null;

  const [type, mode, owner, group] = r.stdout.trim().split('|');
  if (!type || !mode || !/^[0-7]{1,4}$/.test(mode) || owner === undefined || group === undefined) {
    throw new GradingError(`Unexpected stat output: ${JSON.stringify(r.stdout.slice(0, 200))}`);
  }
  return { kind: classify(type), mode, owner, group };
}

function classify(statType: string): FileKind {
  switch (statType) {
    case 'directory':
      return 'directory';
    case 'regular file':
    case 'regular empty file':
      return 'file';
    case 'symbolic link':
      return 'symlink';
    default:
      return 'other';
  }
}

/** Reads up to maxBytes of a regular file (caller must have checked it is one). */
export async function readFileHead(ctx: GradingContext, path: string, maxBytes: number): Promise<string> {
  assertSafePath(path);
  const r = await ctx.runtime.exec(ctx.containerId, ['head', '-c', String(maxBytes), '--', path], {
    user: 'root',
    timeoutMs: 5000,
    maxOutputBytes: maxBytes,
  });
  if (r.timedOut) throw new GradingError('Timed out reading the file');
  if (r.exitCode !== 0) throw new GradingError(`Could not read file: ${r.stderr.trim().slice(0, 200)}`);
  return r.stdout;
}

// Finds the working directory of the student's terminal.
//
// Shells started with `docker exec` have parent PID 0 inside the container,
// something a student cannot fake. We take the newest such bash that owns a
// TTY (the terminal), then the terminal's *foreground* process group, so a
// nested `bash` or a running `less` is followed correctly.
//
// It runs as `student` because reading /proc/<pid>/cwd of another user needs
// CAP_SYS_PTRACE, which the container deliberately does not have.
// This script is a constant; nothing is interpolated into it.
const TERMINAL_CWD_SCRIPT = `
shell=$(ps -eo pid=,ppid=,tty=,comm= --sort=start_time | awk '$2 == 0 && $3 != "?" && $4 == "bash" { p = $1 } END { print p }')
[ -n "$shell" ] || { echo "NO_TERMINAL" >&2; exit 3; }
fg=$(ps -o tpgid= -p "$shell" | tr -d ' ')
case "$fg" in ''|-*|0) fg=$shell ;; esac
readlink "/proc/$fg/cwd" 2>/dev/null || readlink "/proc/$shell/cwd"
`;

/** The directory the student's terminal is currently in, or null if no terminal is open. */
export async function terminalWorkingDirectory(ctx: GradingContext): Promise<string | null> {
  const r = await ctx.runtime.exec(ctx.containerId, ['/bin/bash', '-c', TERMINAL_CWD_SCRIPT], {
    user: 'student',
    timeoutMs: 5000,
    maxOutputBytes: 8192,
  });
  if (r.timedOut) throw new GradingError('Timed out finding the terminal directory');
  if (r.exitCode === 3) return null;
  const cwd = r.stdout.trim();
  if (r.exitCode !== 0 || !cwd.startsWith('/')) {
    throw new GradingError(`Could not read terminal directory: ${r.stderr.trim().slice(0, 200)}`);
  }
  return cwd;
}
