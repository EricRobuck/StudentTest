import type { ValidatorSpec } from '@linuxlab/shared';
import { readFileHead, statPath } from '../inspect.js';
import type { Validator } from '../types.js';

type Spec = Extract<ValidatorSpec, { type: 'file_contains' }>;

/** Only the start of the file is read; exam files are small. */
const MAX_READ_BYTES = 1024 * 1024;

/** Passes when the file contains the expected text (exact, case-sensitive substring). */
export const fileContains: Validator<Spec> = {
  type: 'file_contains',
  async run(ctx, spec) {
    const info = await statPath(ctx, spec.path);
    if (info?.kind !== 'file') {
      return {
        type: this.type,
        passed: false,
        score: 0,
        message: info ? `${spec.path} is not a regular file.` : `File ${spec.path} does not exist.`,
      };
    }
    // Read as root, so this check is independent of the file's permissions.
    const content = await readFileHead(ctx, spec.path, MAX_READ_BYTES);
    const passed = content.includes(spec.text);
    return {
      type: this.type,
      passed,
      score: passed ? 1 : 0,
      message: passed
        ? `${spec.path} contains the expected text.`
        : `${spec.path} does not contain the expected text (check spelling and capitalization).`,
      detail: `first 200 bytes: ${JSON.stringify(content.slice(0, 200))}`,
    };
  },
};
