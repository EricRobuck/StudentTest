import { isSafeAbsolutePath, SETUP_PATH_PREFIXES, type SetupStep } from '@linuxlab/shared';
import type { ContainerRuntime } from '../containers/index.js';

// Prepares a container for an exam's questions (files to find, starting
// folders, files whose permissions must be fixed). Used for real student
// containers and for the sandbox test, so both behave identically.
//
// The scripts below are constants; paths and contents are passed as separate
// arguments ($1, $2, ...), never pasted into the script text. Everything
// created is owned by the student.

// Creates each missing directory along $1, owned by student.
const ENSURE_DIR = `set -f
p="$1"; cur=""; IFS=/
for part in \${p#/}; do
  [ -z "$part" ] && continue
  cur="$cur/$part"
  if [ ! -e "$cur" ]; then mkdir -- "$cur" && chown student:student -- "$cur" || exit 1; fi
done`;

// $1 = path, $2 = base64 content, $3 = octal mode or empty.
const WRITE_FILE = `set -f
f="$1"; d="\${f%/*}"
bash -c "$ENSURE" _ "$d" || exit 1
printf '%s' "$2" | base64 -d > "$f" && chown student:student -- "$f" || exit 1
if [ -n "$3" ]; then chmod -- "$3" "$f" || exit 1; fi`;

export class SetupError extends Error {}

/** Applies setup steps in order; throws SetupError on the first failure. */
export async function applySetup(runtime: ContainerRuntime, containerId: string, steps: readonly SetupStep[]): Promise<void> {
  for (const [i, step] of steps.entries()) {
    // Re-checked here as defence in depth (content was validated when saved).
    if (!isSafeAbsolutePath(step.path) || !SETUP_PATH_PREFIXES.some((p) => step.path.startsWith(p))) {
      throw new SetupError(`Setup step ${i + 1}: path not allowed`);
    }
    const argv =
      step.type === 'create_directory'
        ? ['/bin/bash', '-c', ENSURE_DIR, 'setup', step.path]
        : [
            '/usr/bin/env',
            `ENSURE=${ENSURE_DIR}`,
            '/bin/bash',
            '-c',
            WRITE_FILE,
            'setup',
            step.path,
            Buffer.from(step.content, 'utf8').toString('base64'),
            step.mode ?? '',
          ];
    const r = await runtime.exec(containerId, argv, { user: 'root', timeoutMs: 10_000 });
    if (r.exitCode !== 0) {
      throw new SetupError(`Setup step ${i + 1} (${step.type} ${step.path}) failed: ${r.stderr.trim().slice(0, 200)}`);
    }
  }
}

/** All setup steps of an exam, in question order. */
export function examSetupSteps(questions: ReadonlyArray<{ setup: SetupStep[] }>): SetupStep[] {
  return questions.flatMap((q) => q.setup);
}
