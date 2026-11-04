import type {
  AiStatus,
  ApiError,
  AttemptDetail,
  ExamDetail,
  ExamSettings,
  ExamSummary,
  GenerateQuestionsRequest,
  GenerateQuestionsResponse,
  InstructorQuestion,
  QuestionContent,
  QuestionProgress,
  AttemptSummary,
  AttemptView,
  StartOptionsResponse,
  ExamAnalysis,
  ExamResultView,
  ExamType,
  GradingQueue,
  SuggestGradesResult,
  HealthResponse,
  InstructorAccountSummary,
  InstructorMe,
  InstructorStatus,
  SessionResponse,
  StartSessionRequest,
  StudentExam,
  SubmitResult,
} from '@linuxlab/shared';

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface RequestOptions {
  signal?: AbortSignal;
  body?: unknown;
  /** Lets the request finish even while the page is closing. */
  keepalive?: boolean;
}

async function request<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, opts: RequestOptions = {}): Promise<T> {
  // Same-origin requests send the httpOnly session cookie automatically.
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, {
    method,
    signal: opts.signal,
    keepalive: opts.keepalive,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ApiError | null;
    throw new ApiRequestError(
      res.status,
      body?.error.code ?? 'HTTP_ERROR',
      body?.error.message ?? `Request failed with status ${res.status}`,
    );
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// Concurrent callers share one in-flight request, so two components (or
// React StrictMode's double mount) can't create two containers at once.
let sessionInFlight: Promise<SessionResponse> | null = null;

export const api = {
  health: (signal?: AbortSignal) => request<HealthResponse>('GET', '/api/health', { signal }),

  /**
   * Resumes this browser's exam session. Rejects with status 401 / code
   * NO_SESSION when there is none yet (show the start screen).
   */
  resumeSession(): Promise<SessionResponse> {
    sessionInFlight ??= request<SessionResponse>('POST', '/api/session').finally(() => {
      sessionInFlight = null;
    });
    return sessionInFlight;
  },

  /** The start screen: begins the exam for this student (creates their Linux environment). */
  startSession: (student: StartSessionRequest) =>
    request<SessionResponse>('POST', '/api/session/start', { body: student }),

  /** Start screen: class list and the tests that are open right now. */
  startOptions: (signal?: AbortSignal) => request<StartOptionsResponse>('GET', '/api/start-options', { signal }),

  /** The student's exam (questions only; answers never leave the server). */
  exam: (signal?: AbortSignal) => request<StudentExam>('GET', '/api/exam', { signal }),

  /** Live attempt state: timer, current question, progress, score. */
  attempt: (signal?: AbortSignal) => request<AttemptView>('GET', '/api/attempt', { signal }),

  setCurrentQuestion: (questionId: string) =>
    request<void>('PUT', '/api/attempt/current-question', { body: { questionId } }),

  /** Asks the server to check the container's current state for this question. */
  submit: (questionId: string) =>
    request<SubmitResult>('POST', `/api/exam/questions/${encodeURIComponent(questionId)}/submit`),

  /** Written tests: saves the answer to a question (empty clears it). */
  saveAnswer: (questionId: string, answer: string) =>
    request<QuestionProgress>('PUT', `/api/exam/questions/${encodeURIComponent(questionId)}/answer`, { body: { answer } }),

  finish: () => request<ExamResultView>('POST', '/api/attempt/finish'),

  /** Tells the server the student left the test screen; the server locks the test. */
  reportLeft: (reason: string) =>
    request<AttemptView>('POST', '/api/attempt/left', { body: { reason }, keepalive: true }),

  /** Practice exams only: start over with a fresh attempt and Linux environment. */
  newAttempt: () => request<SessionResponse>('POST', '/api/session/new-attempt'),

  result: (signal?: AbortSignal) => request<ExamResultView>('GET', '/api/attempt/result', { signal }),
};

/** Instructor endpoints (separate cookie; the server refuses these for students). */
export const instructorApi = {
  me: (signal?: AbortSignal) => request<InstructorStatus>('GET', '/api/instructor/me', { signal }),
  login: (username: string, password: string) => request<void>('POST', '/api/instructor/login', { body: { username, password } }),
  logout: () => request<void>('POST', '/api/instructor/logout'),

  // My account
  updateMyAccount: (body: { name: string; username: string }) => request<InstructorMe>('PUT', '/api/instructor/account', { body }),
  changeMyPassword: (current: string, next: string) =>
    request<void>('POST', '/api/instructor/account/password', { body: { current, next } }),

  // Professors (administrator only)
  accounts: () => request<InstructorAccountSummary[]>('GET', '/api/instructor/accounts'),
  createAccount: (body: { name: string; username: string; password: string }) =>
    request<InstructorAccountSummary>('POST', '/api/instructor/accounts', { body }),
  resetAccountPassword: (id: string, password: string) =>
    request<void>('POST', `/api/instructor/accounts/${encodeURIComponent(id)}/password`, { body: { password } }),
  setAccountActive: (id: string, active: boolean) =>
    request<void>('POST', `/api/instructor/accounts/${encodeURIComponent(id)}/active`, { body: { active } }),

  attempts: (signal?: AbortSignal) => request<AttemptSummary[]>('GET', '/api/instructor/attempts', { signal }),
  attempt: (id: string, signal?: AbortSignal) =>
    request<AttemptDetail>('GET', `/api/instructor/attempts/${encodeURIComponent(id)}`, { signal }),
  /** Marks a question correct (true) or not correct (false); null goes back to the automatic grade. */
  setGrade: (attemptId: string, questionId: string, correct: boolean | null) =>
    request<void>('PUT', `/api/instructor/attempts/${encodeURIComponent(attemptId)}/questions/${encodeURIComponent(questionId)}/grade`, {
      body: { correct },
    }),
  /** Gives a question this many points (short answers). */
  setPoints: (attemptId: string, questionId: string, points: number) =>
    request<void>('PUT', `/api/instructor/attempts/${encodeURIComponent(attemptId)}/questions/${encodeURIComponent(questionId)}/grade`, {
      body: { points },
    }),
  examAnalysis: (examId: string, signal?: AbortSignal) => request<ExamAnalysis>('GET', `${examPath(examId)}/analysis`, { signal }),
  gradingQueue: (examId: string) => request<GradingQueue>('GET', `${examPath(examId)}/grading`),
  suggestGrades: (examId: string, questionId: string) =>
    request<SuggestGradesResult>('POST', `${questionPath(examId, questionId)}/suggest-grades`),
  deleteAttempt: (id: string) => request<void>('DELETE', `/api/instructor/attempts/${encodeURIComponent(id)}`),
  unlock: (id: string) => request<void>('POST', `/api/instructor/attempts/${encodeURIComponent(id)}/unlock`),

  // Exam editor
  aiStatus: (signal?: AbortSignal) => request<AiStatus>('GET', '/api/instructor/ai', { signal }),
  exams: (signal?: AbortSignal) => request<ExamSummary[]>('GET', '/api/instructor/exams', { signal }),
  exam: (id: string, signal?: AbortSignal) => request<ExamDetail>('GET', examPath(id), { signal }),
  createExam: (title: string, examType: ExamType) =>
    request<ExamDetail>('POST', '/api/instructor/exams', { body: { title, examType } }),
  updateExam: (id: string, body: { title: string; description: string; settings: ExamSettings }) =>
    request<ExamDetail>('PUT', examPath(id), { body }),
  deleteExam: (id: string) => request<void>('DELETE', examPath(id)),
  setExamEnabled: (id: string, enabled: boolean) =>
    request<ExamDetail>('POST', `${examPath(id)}/${enabled ? 'enable' : 'disable'}`),
  reorder: (id: string, order: string[]) => request<ExamDetail>('PUT', `${examPath(id)}/order`, { body: { order } }),
  addQuestion: (examId: string, content: QuestionContent) =>
    request<InstructorQuestion>('POST', `${examPath(examId)}/questions`, { body: content }),
  updateQuestion: (examId: string, questionId: string, content: QuestionContent) =>
    request<InstructorQuestion>('PUT', questionPath(examId, questionId), { body: content }),
  deleteQuestion: (examId: string, questionId: string) => request<void>('DELETE', questionPath(examId, questionId)),
  approve: (examId: string, questionId: string) =>
    request<InstructorQuestion>('POST', `${questionPath(examId, questionId)}/approve`),
  unapprove: (examId: string, questionId: string) =>
    request<InstructorQuestion>('POST', `${questionPath(examId, questionId)}/unapprove`),
  retest: (examId: string, questionId: string) => request<void>('POST', `${questionPath(examId, questionId)}/test`),
  generate: (examId: string, body: GenerateQuestionsRequest) =>
    request<GenerateQuestionsResponse>('POST', `${examPath(examId)}/generate`, { body }),
};

function examPath(id: string): string {
  return `/api/instructor/exams/${encodeURIComponent(id)}`;
}

function questionPath(examId: string, questionId: string): string {
  return `${examPath(examId)}/questions/${encodeURIComponent(questionId)}`;
}
