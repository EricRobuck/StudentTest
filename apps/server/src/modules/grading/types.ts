import type { ValidatorSpec, ValidatorType } from '@linuxlab/shared';
import type { ContainerRuntime } from '../containers/index.js';

/** Everything a validator needs to inspect one student's environment. */
export interface GradingContext {
  runtime: ContainerRuntime;
  containerId: string;
}

export interface RuleResult {
  type: ValidatorType;
  passed: boolean;
  /** 0..1. Pass/fail validators return 0 or 1; the field exists for future partial credit. */
  score: number;
  /** Student-facing explanation. */
  message: string;
  /** Extra detail for instructors (raw observed values, errors). Never sent to students. */
  detail?: string;
}

/**
 * A validator checks one kind of state inside the container. Adding a new
 * validator type = add it to ValidatorSpec (shared) + one file implementing
 * this interface + one line in the registry. The compiler enforces the rest.
 */
export interface Validator<S extends ValidatorSpec = ValidatorSpec> {
  readonly type: S['type'];
  run(ctx: GradingContext, spec: S): Promise<RuleResult>;
}

/** Validators thrown errors become failed results with this class of error. */
export class GradingError extends Error {}
