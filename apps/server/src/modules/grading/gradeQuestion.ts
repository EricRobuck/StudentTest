import type { ValidationSpec } from '@linuxlab/shared';
import { validatorFor } from './registry.js';
import type { GradingContext, RuleResult } from './types.js';

export interface QuestionGrade {
  passed: boolean;
  /** 0..1 fraction of credit; the MVP awards all or nothing. */
  score: number;
  rules: RuleResult[];
}

/**
 * Runs every rule of a question and combines them:
 *  - mode 'all': passes only if every rule passes
 *  - mode 'any': passes if at least one rule passes
 * A validator that throws (bad definition, timeout, container problem) counts
 * as a failed rule instead of crashing the submission.
 */
export async function gradeQuestion(ctx: GradingContext, validation: ValidationSpec): Promise<QuestionGrade> {
  if (validation.rules.length === 0) throw new Error('Question has no validation rules');

  const rules: RuleResult[] = [];
  // Sequential on purpose: keeps load on the student's small container low.
  for (const spec of validation.rules) {
    try {
      rules.push(await validatorFor(spec).run(ctx, spec));
    } catch (err) {
      rules.push({
        type: spec.type,
        passed: false,
        score: 0,
        message: 'This check could not be completed. Please try submitting again.',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const passed = validation.mode === 'all' ? rules.every((r) => r.passed) : rules.some((r) => r.passed);
  return { passed, score: passed ? 1 : 0, rules };
}
