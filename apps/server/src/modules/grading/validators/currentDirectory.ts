import type { ValidatorSpec } from '@linuxlab/shared';
import { assertSafePath, terminalWorkingDirectory } from '../inspect.js';
import type { Validator } from '../types.js';

type Spec = Extract<ValidatorSpec, { type: 'current_directory' }>;

/** Passes when the student's terminal is currently in the expected directory. */
export const currentDirectory: Validator<Spec> = {
  type: 'current_directory',
  async run(ctx, spec) {
    assertSafePath(spec.path);
    const expected = normalizeDir(spec.path);
    const cwd = await terminalWorkingDirectory(ctx);
    if (cwd === null) {
      return {
        type: this.type,
        passed: false,
        score: 0,
        message: 'Your terminal is not connected. Reopen the page and try again.',
      };
    }
    const actual = normalizeDir(cwd);
    const passed = actual === expected;
    return {
      type: this.type,
      passed,
      score: passed ? 1 : 0,
      message: passed
        ? `Your terminal is in ${expected}.`
        : `Your terminal is in ${actual}, not ${expected}.`,
      detail: `cwd=${cwd}`,
    };
  },
};

function normalizeDir(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}
