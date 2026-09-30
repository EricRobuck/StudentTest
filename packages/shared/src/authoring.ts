// Exam authoring: the editable content of a question, its validation (used
// by the instructor editor, the server, and to vet AI-generated drafts), and
// the instructor-only views of exams.

import type { Difficulty, ExamMode, SetupStep, ValidationSpec, ValidatorSpec } from './exam.js';

export interface ExamSettings {
  mode: ExamMode;
  allowHints: boolean;
  /** null = untimed. */
  timeLimitMinutes: number | null;
  /** null = unlimited attempts per question. */
  maxAttemptsPerQuestion: number | null;
  /** Show pass/fail and reasons right after each submission. */
  showFeedback: boolean;
  showScoreDuringExam: boolean;
  /** Accept only one submission per question. */
  lockAfterSubmit: boolean;
  /**
   * Admin exercises: students may use sudo (passwordless). Weakens isolation
   * and grading integrity; see docs/SECURITY.md. Missing = false.
   */
  allowSudo?: boolean;
  /**
   * Leaving the test screen (other tab/window, minimizing, closing) locks the
   * test until the instructor unlocks it. Missing = true.
   */
  lockOnLeave?: boolean;
  /**
   * Three tries per question. A correct answer earns 100% of the points on the
   * first try, 90% on the second and 60% on the third; three wrong answers
   * earn 0 and close the question. Missing = true.
   */
  threeTries?: boolean;
}

/** Share of a question's points a correct answer earns on try 1, 2 and 3 (three-tries rule). */
export const THREE_TRIES_CREDIT = [1, 0.9, 0.6] as const;

/**
 * How many submissions a question allows (null = unlimited). The three-tries
 * rule always means exactly three; "Attempts per question" only applies when
 * it is off.
 */
export function effectiveMaxAttempts(s: Pick<ExamSettings, 'maxAttemptsPerQuestion' | 'threeTries'>): number | null {
  if (s.threeTries === false) return s.maxAttemptsPerQuestion;
  return THREE_TRIES_CREDIT.length;
}

/** Share of the points a correct answer earns after `previousTries` earlier submissions. */
export function tryCredit(s: Pick<ExamSettings, 'threeTries'>, previousTries: number): number {
  if (s.threeTries === false) return 1;
  return THREE_TRIES_CREDIT[previousTries] ?? 0;
}

/** Everything an instructor (or the AI) writes for one question. */
export interface QuestionContent {
  title: string;
  /** The task. Text inside `backticks` is shown as code. */
  text: string;
  instructions?: string;
  points: number;
  category: string;
  difficulty: Difficulty;
  /** Prepares the student's environment before the exam (files to find, etc.). */
  setup: SetupStep[];
  validation: ValidationSpec;
  hint?: string;
  explanation?: string;
  /**
   * Instructor-only model answer: shell commands a student could type. The
   * sandbox test runs them to prove the question can be passed. Never shown
   * to students.
   */
  solution: string[];
}

export type QuestionStatus = 'draft' | 'approved';
export type QuestionSource = 'sample' | 'manual' | 'ai';

/** Result of test-running a question in a throwaway container. */
export interface QuestionVerification {
  status: 'untested' | 'running' | 'passed' | 'failed';
  checkedAt: string | null;
  /** Must be false: a question that passes before anything is done is broken. */
  passedBeforeSolution: boolean | null;
  /** Must be true: the model answer has to pass. */
  passedAfterSolution: boolean | null;
  /** Human-readable findings (check messages, errors). */
  notes: string[];
}

export interface InstructorQuestion {
  id: string;
  position: number;
  status: QuestionStatus;
  source: QuestionSource;
  content: QuestionContent;
  verification: QuestionVerification;
}

export interface ExamSummary {
  id: string;
  title: string;
  description: string | null;
  /** Switched on by the instructor. */
  enabled: boolean;
  /** Enabled and has approved questions: students can choose it. */
  open: boolean;
  settings: ExamSettings;
  approvedCount: number;
  draftCount: number;
  totalPoints: number;
}

export interface ExamDetail extends ExamSummary {
  questions: InstructorQuestion[];
}

/** Body of POST /api/instructor/exams/:id/generate. */
export interface GenerateQuestionsRequest {
  /** What the questions should cover, in the instructor's words. */
  topic: string;
  count: number;
  difficulty: Difficulty;
  pointsEach: number;
  /** Optional extra guidance ("use the /srv/webapp folder", "include grep"). */
  notes?: string;
}

export interface GenerateQuestionsResponse {
  created: InstructorQuestion[];
  /** Drafts the AI produced that failed validation and were discarded. */
  rejected: Array<{ title: string; errors: string[] }>;
}

export interface AiStatus {
  /** false when the server has no OPENAI_API_KEY configured. */
  enabled: boolean;
  model: string;
}

// ---------------------------------------------------------------- validation

export const AUTHORING_LIMITS = {
  titleMax: 120,
  textMax: 2000,
  instructionsMax: 1000,
  categoryMax: 40,
  hintMax: 500,
  explanationMax: 2000,
  pointsMax: 100,
  setupStepsMax: 20,
  fileContentMax: 16 * 1024,
  rulesMax: 10,
  containsTextMax: 500,
  solutionCommandsMax: 20,
  solutionCommandMax: 500,
  generateCountMax: 30,
  topicMax: 500,
  notesMax: 1000,
} as const;

/**
 * Setup may only create things in these places. Keeps generated or
 * mistyped setup away from system files (and the logging hook).
 */
export const SETUP_PATH_PREFIXES = ['/home/student/', '/tmp/', '/var/tmp/', '/opt/', '/srv/'] as const;

const DIFFICULTIES: readonly Difficulty[] = ['beginner', 'intermediate', 'advanced'];
const OCTAL_MODE = /^[0-7]{3,4}$/;

/** Absolute, no NUL/newlines, no `..` segments, reasonable length. */
export function isSafeAbsolutePath(path: string): boolean {
  return path.startsWith('/') && path.length <= 4096 && !/[\0\n\r]/.test(path) && !path.split('/').includes('..');
}

export type ContentCheck = { ok: true; value: QuestionContent } | { ok: false; errors: string[] };

/**
 * Strictly checks and normalises question content from any source (editor
 * form, AI output). Unknown fields are dropped; nothing is trusted.
 */
export function validateQuestionContent(input: unknown): ContentCheck {
  const errors: string[] = [];
  const raw = asObject(input);
  const L = AUTHORING_LIMITS;

  const title = str(raw.title);
  const text = str(raw.text);
  const instructions = optStr(raw.instructions);
  const category = str(raw.category) || 'General';
  const hint = optStr(raw.hint);
  const explanation = optStr(raw.explanation);
  const points = raw.points;
  const difficulty = raw.difficulty as Difficulty;

  if (!title) errors.push('Title is required.');
  else if (title.length > L.titleMax) errors.push(`Title must be at most ${L.titleMax} characters.`);
  if (!text) errors.push('Question text is required.');
  else if (text.length > L.textMax) errors.push(`Question text must be at most ${L.textMax} characters.`);
  if (instructions && instructions.length > L.instructionsMax) errors.push('Instructions are too long.');
  if (category.length > L.categoryMax) errors.push('Category is too long.');
  if (hint && hint.length > L.hintMax) errors.push('Hint is too long.');
  if (explanation && explanation.length > L.explanationMax) errors.push('Explanation is too long.');
  if (typeof points !== 'number' || !Number.isInteger(points) || points < 1 || points > L.pointsMax) {
    errors.push(`Points must be a whole number from 1 to ${L.pointsMax}.`);
  }
  if (!DIFFICULTIES.includes(difficulty)) errors.push('Difficulty must be beginner, intermediate or advanced.');

  // Setup steps
  const setup: SetupStep[] = [];
  const rawSetup = Array.isArray(raw.setup) ? raw.setup : [];
  if (rawSetup.length > L.setupStepsMax) errors.push(`At most ${L.setupStepsMax} setup steps.`);
  rawSetup.slice(0, L.setupStepsMax).forEach((s, i) => {
    const step = asObject(s);
    const path = str(step.path);
    const where = `Setup step ${i + 1}`;
    if (!isSafeAbsolutePath(path) || !SETUP_PATH_PREFIXES.some((p) => path.startsWith(p) && path.length > p.length)) {
      errors.push(`${where}: path must be inside ${SETUP_PATH_PREFIXES.join(', ')}.`);
      return;
    }
    if (step.type === 'create_directory') {
      setup.push({ type: 'create_directory', path });
    } else if (step.type === 'create_file') {
      const content = typeof step.content === 'string' ? step.content : '';
      const mode = optStr(step.mode);
      if (content.length > L.fileContentMax) errors.push(`${where}: file content is too long.`);
      if (mode && !OCTAL_MODE.test(mode)) errors.push(`${where}: mode must be octal like 644.`);
      setup.push({ type: 'create_file', path, content, ...(mode ? { mode } : {}) });
    } else {
      errors.push(`${where}: unknown type.`);
    }
  });

  // Validation rules
  const validationRaw = asObject(raw.validation);
  const mode = validationRaw.mode === 'any' ? 'any' : 'all';
  const rawRules = Array.isArray(validationRaw.rules) ? validationRaw.rules : [];
  const rules: ValidatorSpec[] = [];
  if (rawRules.length === 0) errors.push('At least one check is required.');
  if (rawRules.length > L.rulesMax) errors.push(`At most ${L.rulesMax} checks.`);
  rawRules.slice(0, L.rulesMax).forEach((r, i) => {
    const rule = validateRule(asObject(r), `Check ${i + 1}`, errors);
    if (rule) rules.push(rule);
  });

  // Solution
  const rawSolution = Array.isArray(raw.solution) ? raw.solution : [];
  const solution = rawSolution.map((c) => (typeof c === 'string' ? c.trim() : '')).filter(Boolean);
  if (solution.length === 0) errors.push('A model answer (at least one command) is required so the question can be tested.');
  if (solution.length > L.solutionCommandsMax) errors.push(`At most ${L.solutionCommandsMax} solution commands.`);
  if (solution.some((c) => c.length > L.solutionCommandMax || /[\r\n]/.test(c))) {
    errors.push(`Each solution command must be one line of at most ${L.solutionCommandMax} characters.`);
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      title,
      text,
      ...(instructions ? { instructions } : {}),
      points: points as number,
      category,
      difficulty,
      setup,
      validation: { mode, rules },
      ...(hint ? { hint } : {}),
      ...(explanation ? { explanation } : {}),
      solution,
    },
  };
}

function validateRule(r: Record<string, unknown>, where: string, errors: string[]): ValidatorSpec | undefined {
  const path = str(r.path);
  if (!isSafeAbsolutePath(path)) {
    errors.push(`${where}: path must be an absolute path like /tmp/example.`);
    return undefined;
  }
  switch (r.type) {
    case 'current_directory':
    case 'directory_exists':
    case 'file_exists':
      return { type: r.type, path };
    case 'file_contains': {
      const text = typeof r.text === 'string' ? r.text : '';
      if (!text || text.length > AUTHORING_LIMITS.containsTextMax) {
        errors.push(`${where}: expected text is required (max ${AUTHORING_LIMITS.containsTextMax} characters).`);
        return undefined;
      }
      return { type: 'file_contains', path, text };
    }
    case 'file_permissions': {
      const mode = str(r.mode);
      if (!OCTAL_MODE.test(mode)) {
        errors.push(`${where}: permissions must be octal like 640.`);
        return undefined;
      }
      return { type: 'file_permissions', path, mode };
    }
    default:
      errors.push(`${where}: unknown check type.`);
      return undefined;
  }
}

export type SettingsCheck = { ok: true; value: ExamSettings } | { ok: false; errors: string[] };

export function validateExamSettings(input: unknown): SettingsCheck {
  const raw = asObject(input);
  const errors: string[] = [];
  const intOrNull = (v: unknown, name: string, max: number): number | null => {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > max) {
      errors.push(`${name} must be a whole number from 1 to ${max}, or empty.`);
      return null;
    }
    return v;
  };
  const value: ExamSettings = {
    mode: raw.mode === 'exam' ? 'exam' : 'practice',
    allowHints: raw.allowHints === true,
    timeLimitMinutes: intOrNull(raw.timeLimitMinutes, 'Time limit', 600),
    maxAttemptsPerQuestion: intOrNull(raw.maxAttemptsPerQuestion, 'Attempts per question', 50),
    showFeedback: raw.showFeedback === true,
    showScoreDuringExam: raw.showScoreDuringExam === true,
    lockAfterSubmit: raw.lockAfterSubmit === true,
    allowSudo: raw.allowSudo === true,
    lockOnLeave: raw.lockOnLeave !== false,
    threeTries: raw.threeTries !== false,
  };
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}

function asObject(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function optStr(v: unknown): string | undefined {
  const s = str(v);
  return s ? s : undefined;
}
