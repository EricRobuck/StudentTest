// Who is taking the exam. Self-reported on the start screen until student
// accounts exist; used to label attempts, results and instructor views.
//
// The same validation runs in the browser (instant feedback) and on the
// server (the only check that counts).

export interface StudentInfo {
  name: string;
  className: string;
}

/** Body of POST /api/session/start. */
export type StartSessionRequest = StudentInfo;

/** Response body of GET /api/classes. */
export interface ClassListResponse {
  /** The classes to choose from, or null when students type their class. */
  classes: string[] | null;
}

export const STUDENT_LIMITS = {
  nameMin: 2,
  nameMax: 80,
  classMax: 40,
} as const;

// Letters from any language, plus spaces, hyphens, apostrophes and periods
// (e.g. "Mary-Jane O'Neil Jr.").
const NAME_PATTERN = /^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u;
const CLASS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;

export type StudentInfoResult =
  | { ok: true; value: StudentInfo }
  | { ok: false; errors: Partial<Record<keyof StudentInfo, string>> };

/** Trims, collapses spaces, and checks a start-screen submission. */
export function validateStudentInfo(input: unknown, allowedClasses: readonly string[] | null): StudentInfoResult {
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const name = typeof raw.name === 'string' ? raw.name.replace(/\s+/g, ' ').trim() : '';
  const className = typeof raw.className === 'string' ? raw.className.replace(/\s+/g, ' ').trim() : '';
  const errors: Partial<Record<keyof StudentInfo, string>> = {};

  if (name.length < STUDENT_LIMITS.nameMin) errors.name = 'Please enter your full name.';
  else if (name.length > STUDENT_LIMITS.nameMax) errors.name = `Name must be at most ${STUDENT_LIMITS.nameMax} characters.`;
  else if (!NAME_PATTERN.test(name)) errors.name = "Use letters, spaces, hyphens, apostrophes or periods only.";

  if (allowedClasses) {
    if (!allowedClasses.includes(className)) errors.className = 'Please choose your class.';
  } else if (className.length === 0) errors.className = 'Please enter your class.';
  else if (className.length > STUDENT_LIMITS.classMax) errors.className = `Class must be at most ${STUDENT_LIMITS.classMax} characters.`;
  else if (!CLASS_PATTERN.test(className)) errors.className = 'Use letters, numbers, spaces, periods, hyphens or underscores.';

  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, value: { name, className } };
}
