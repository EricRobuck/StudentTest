import type { ValidatorSpec } from '@linuxlab/shared';
import { statPath } from '../inspect.js';
import type { Validator } from '../types.js';

type Spec = Extract<ValidatorSpec, { type: 'file_exists' }>;

/** Passes when the path is a regular file (not a directory or symlink). */
export const fileExists: Validator<Spec> = {
  type: 'file_exists',
  async run(ctx, spec) {
    const info = await statPath(ctx, spec.path);
    const passed = info?.kind === 'file';
    let message: string;
    if (passed) message = `File ${spec.path} exists.`;
    else if (!info) message = `File ${spec.path} does not exist.`;
    else message = `${spec.path} exists but is a ${info.kind}, not a regular file.`;
    return { type: this.type, passed, score: passed ? 1 : 0, message, detail: info ? `kind=${info.kind}` : 'missing' };
  },
};
