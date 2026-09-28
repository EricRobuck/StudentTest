// Exam and question contracts.
//
// Two views of a question exist:
//  - The full definition (validators, setup, explanation) lives only on the
//    server and, later, in the instructor tools.
//  - StudentQuestion is the redacted view sent to the student's browser. It
//    must never contain anything that reveals or checks the answer.

export type Difficulty = 'beginner' | 'intermediate' | 'advanced';
export type ExamMode = 'practice' | 'exam';

/** One state check run inside the student's container after they submit. */
export type ValidatorSpec =
  | { type: 'current_directory'; path: string }
  | { type: 'directory_exists'; path: string }
  | { type: 'file_exists'; path: string }
  | { type: 'file_contains'; path: string; text: string }
  | { type: 'file_permissions'; path: string; /** octal, e.g. "640" */ mode: string };

export type ValidatorType = ValidatorSpec['type'];

/** A question passes when ALL rules pass, or when ANY rule passes. */
export interface ValidationSpec {
  mode: 'all' | 'any';
  rules: ValidatorSpec[];
}

/** Prepares the container before a question is shown (e.g. hide a file to find). */
export type SetupStep =
  | { type: 'create_directory'; path: string }
  | { type: 'create_file'; path: string; content: string; /** octal */ mode?: string };

/** What the student's browser receives for a question. */
export interface StudentQuestion {
  id: string;
  /** 1-based position in the exam. */
  number: number;
  title: string;
  text: string;
  instructions?: string;
  points: number;
  category: string;
  difficulty: Difficulty;
  /** Only present when the exam allows hints. */
  hint?: string;
}

/** Outcome of one validation rule, as shown to the student. */
export interface RuleResultView {
  passed: boolean;
  /** Short explanation, e.g. "Your terminal is in /home/student, not /etc". */
  message: string;
}

/** Response body of POST /api/exam/questions/:questionId/submit. */
export interface SubmitResult {
  questionId: string;
  passed: boolean;
  pointsAwarded: number;
  maxPoints: number;
  rules: RuleResultView[];
  gradedAt: string;
}

/** Response body of GET /api/exam. */
export interface StudentExam {
  id: string;
  title: string;
  mode: ExamMode;
  totalPoints: number;
  questions: StudentQuestion[];
}
