import type { ValidatorSpec, ValidatorType } from '@linuxlab/shared';
import type { Validator } from './types.js';
import { currentDirectory } from './validators/currentDirectory.js';
import { directoryExists } from './validators/directoryExists.js';
import { fileContains } from './validators/fileContains.js';
import { fileExists } from './validators/fileExists.js';
import { filePermissions } from './validators/filePermissions.js';

// Every ValidatorSpec type must have exactly one implementation here; a
// missing or mismatched entry is a compile error.
const registry: { [K in ValidatorType]: Validator<Extract<ValidatorSpec, { type: K }>> } = {
  current_directory: currentDirectory,
  directory_exists: directoryExists,
  file_exists: fileExists,
  file_contains: fileContains,
  file_permissions: filePermissions,
};

export function validatorFor<S extends ValidatorSpec>(spec: S): Validator<S> {
  return registry[spec.type] as unknown as Validator<S>;
}
