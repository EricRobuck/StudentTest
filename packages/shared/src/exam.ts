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

/** Immediate result of one submission (only when the exam shows feedback). */
export interface SubmitFeedback {
  passed: boolean;
  pointsAwarded: number;
  maxPoints: number;
  rules: RuleResultView[];
}

export interface ScoreView {
  earned: number;
  max: number;
}

/** A student's standing on one question. */
export interface QuestionProgress {
  questionId: string;
  /** Number of submissions so far. */
  attempts: number;
  /** null = unlimited. */
  attemptsRemaining: number | null;
  /** No further submissions accepted (attempt limit, lock-after-submit, or exam over). */
  locked: boolean;
  /** Best result so far; null if never submitted or results are hidden until the end. */
  best: { passed: boolean; pointsAwarded: number } | null;
}

/** Response body of POST /api/exam/questions/:questionId/submit. */
export interface SubmitResult {
  questionId: string;
  attemptNumber: number;
  /** null when the exam hides results until completion ("answer recorded"). */
  feedback: SubmitFeedback | null;
  progress: QuestionProgress;
  /** null when the score is hidden until completion. */
  score: ScoreView | null;
}

export type AttemptStatus = 'in_progress' | 'completed';
export type AttemptEndReason = 'finished' | 'time_expired';

/** Response body of GET /api/attempt: the student's live exam state. */
export interface AttemptView {
  id: string;
  status: AttemptStatus;
  startedAt: string;
  /** null = untimed. The client counts down using serverTime to correct its clock. */
  deadlineAt: string | null;
  serverTime: string;
  currentQuestionId: string | null;
  score: ScoreView | null;
  questions: QuestionProgress[];
}

/** Response body of GET /api/attempt/result (after completion). */
export interface ExamResultView {
  examTitle: string;
  studentName: string | null;
  className: string | null;
  startedAt: string;
  completedAt: string;
  endReason: AttemptEndReason;
  score: ScoreView;
  /** 0..100, rounded to one decimal. */
  percentage: number;
  /** Practice exams can be taken again; real exams cannot. */
  canRetake: boolean;
  questions: Array<{
    questionId: string;
    number: number;
    title: string;
    pointsAwarded: number;
    maxPoints: number;
    passed: boolean;
    attempts: number;
  }>;
}

/** The exam rules a student is allowed to know. */
export interface StudentExamRules {
  timeLimitMinutes: number | null;
  maxAttemptsPerQuestion: number | null;
  showFeedback: boolean;
  showScoreDuringExam: boolean;
  lockAfterSubmit: boolean;
}

/** Response body of GET /api/exam. */
export interface StudentExam {
  id: string;
  title: string;
  mode: ExamMode;
  totalPoints: number;
  rules: StudentExamRules;
  questions: StudentQuestion[];
}
