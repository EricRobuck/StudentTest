import { randomUUID } from 'node:crypto';
import type { QuestionContent, QuestionVerification } from '@linuxlab/shared';
import type { ContainerRuntime } from '../containers/index.js';
import { applySetup } from '../exams/setupRunner.js';
import { gradeQuestion } from '../grading/index.js';

const COMMAND_TIMEOUT_MS = 15_000;

/**
 * Test-runs a question in a throwaway container, exactly as a student would
 * experience it:
 *   1. apply the question's setup
 *   2. grade → must FAIL (otherwise the question gives free points)
 *   3. type the model answer into a real terminal shell, one command at a time
 *   4. grade → must PASS (otherwise nobody can get the points)
 * Nothing here touches a student's container.
 */
export async function verifyQuestion(
  runtime: ContainerRuntime,
  content: QuestionContent,
  options: { allowSudo: boolean },
): Promise<QuestionVerification> {
  const notes: string[] = [];
  const checkedAt = () => new Date().toISOString();
  let containerId: string | undefined;

  try {
    // Same environment as the students of this exam (with or without sudo).
    const c = await runtime.createSessionContainer(`verify-${randomUUID().slice(0, 12)}`, options);
    containerId = c.containerId;
    await applySetup(runtime, containerId, content.setup);

    const shell = await runtime.attachShell(containerId, { cols: 120, rows: 30 });
    let output = '';
    shell.onData((chunk) => {
      output += chunk.toString('utf8');
      if (output.length > 200_000) output = output.slice(-100_000);
    });
    try {
      await waitFor(() => /\$ $/.test(stripAnsi(output)), 10_000);
      const ctx = { runtime, containerId };

      const before = await gradeQuestion(ctx, content.validation);
      notes.push(`Before the model answer: ${before.passed ? 'PASSED (should fail!)' : 'fails, as it should'}.`);
      if (before.passed) notes.push('The question gives points without any work: tighten the checks or add setup.');

      for (const [i, command] of content.solution.entries()) {
        // The marker is printed with arithmetic so the echoed command line itself
        // (which contains the expression, not the result) can't match it.
        const n = 100000 + i;
        const done = `__LLV_${n + 1}__`;
        shell.write(Buffer.from(`${command}\n`));
        shell.write(Buffer.from(`echo __LLV_$((${n}+1))__\n`));
        const ok = await waitFor(() => stripAnsi(output).includes(`\n${done}`), COMMAND_TIMEOUT_MS);
        if (!ok) {
          notes.push(`Model answer step ${i + 1} (\`${command}\`) did not finish within ${COMMAND_TIMEOUT_MS / 1000}s (interactive or hanging command?).`);
          shell.write(Buffer.from('\x03')); // Ctrl+C
          break;
        }
      }

      const after = await gradeQuestion(ctx, content.validation);
      notes.push(`After the model answer: ${after.passed ? 'passes' : 'FAILS'}.`);
      for (const r of after.rules) if (!r.passed) notes.push(`• ${r.message}${r.detail ? ` (${r.detail})` : ''}`);

      const ok = !before.passed && after.passed;
      return {
        status: ok ? 'passed' : 'failed',
        checkedAt: checkedAt(),
        passedBeforeSolution: before.passed,
        passedAfterSolution: after.passed,
        notes,
      };
    } finally {
      shell.close();
    }
  } catch (err) {
    notes.push(`Test could not run: ${err instanceof Error ? err.message : String(err)}`);
    return { status: 'failed', checkedAt: checkedAt(), passedBeforeSolution: null, passedAfterSolution: null, notes };
  } finally {
    if (containerId) await runtime.destroy(containerId).catch(() => undefined);
  }
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\r/g, '');
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return predicate();
}
