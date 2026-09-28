import type { ValidatorSpec } from '@linuxlab/shared';
import { statPath } from '../inspect.js';
import type { Validator } from '../types.js';

type Spec = Extract<ValidatorSpec, { type: 'directory_exists' }>;

/** Passes when the path is a real directory (a symlink to one does not count). */
export const directoryExists: Validator<Spec> = {
  type: 'directory_exists',
  async run(ctx, spec) {
    const info = await statPath(ctx, spec.path);
    const passed = info?.kind === 'directory';
    let message: string;
    if (passed) message = `Directory ${spec.path} exists.`;
    else if (!info) message = `Directory ${spec.path} does not exist.`;
    else message = `${spec.path} exists but is a ${info.kind}, not a directory.`;
    return { type: this.type, passed, score: passed ? 1 : 0, message, detail: info ? `kind=${info.kind}` : 'missing' };
  },
};
