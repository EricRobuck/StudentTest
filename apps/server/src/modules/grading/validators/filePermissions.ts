import type { ValidatorSpec } from '@linuxlab/shared';
import { statPath } from '../inspect.js';
import { GradingError, type Validator } from '../types.js';

type Spec = Extract<ValidatorSpec, { type: 'file_permissions' }>;

/** Passes when the path's permission bits equal the expected octal mode, e.g. 640. */
export const filePermissions: Validator<Spec> = {
  type: 'file_permissions',
  async run(ctx, spec) {
    if (!/^[0-7]{3,4}$/.test(spec.mode)) {
      throw new GradingError(`Invalid permission mode in exam definition: ${spec.mode}`);
    }
    const expected = parseInt(spec.mode, 8);
    const info = await statPath(ctx, spec.path);
    if (!info) {
      return { type: this.type, passed: false, score: 0, message: `${spec.path} does not exist.` };
    }
    const actual = parseInt(info.mode, 8);
    const passed = actual === expected;
    const shown = (n: number) => n.toString(8).padStart(3, '0');
    return {
      type: this.type,
      passed,
      score: passed ? 1 : 0,
      message: passed
        ? `${spec.path} has permissions ${shown(expected)}.`
        : `${spec.path} has permissions ${shown(actual)}, expected ${shown(expected)}.`,
      detail: `mode=${info.mode}`,
    };
  },
};
