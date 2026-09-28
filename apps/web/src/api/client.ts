import type {
  ApiError,
  AttemptDetail,
  AttemptSummary,
  AttemptView,
  ClassListResponse,
  ExamResultView,
  HealthResponse,
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
}

async function request<T>(method: 'GET' | 'POST' | 'PUT', path: string, opts: RequestOptions = {}): Promise<T> {
  // Same-origin requests send the httpOnly session cookie automatically.
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, {
    method,
    signal: opts.signal,
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

  classes: (signal?: AbortSignal) => request<ClassListResponse>('GET', '/api/classes', { signal }),

  /** The student's exam (questions only; answers never leave the server). */
  exam: (signal?: AbortSignal) => request<StudentExam>('GET', '/api/exam', { signal }),

  /** Live attempt state: timer, current question, progress, score. */
  attempt: (signal?: AbortSignal) => request<AttemptView>('GET', '/api/attempt', { signal }),

  setCurrentQuestion: (questionId: string) =>
    request<void>('PUT', '/api/attempt/current-question', { body: { questionId } }),

  /** Asks the server to check the container's current state for this question. */
  submit: (questionId: string) =>
    request<SubmitResult>('POST', `/api/exam/questions/${encodeURIComponent(questionId)}/submit`),

  finish: () => request<ExamResultView>('POST', '/api/attempt/finish'),

  /** Practice exams only: start over with a fresh attempt and Linux environment. */
  newAttempt: () => request<SessionResponse>('POST', '/api/session/new-attempt'),

  result: (signal?: AbortSignal) => request<ExamResultView>('GET', '/api/attempt/result', { signal }),
};

/** Instructor endpoints (separate cookie; the server refuses these for students). */
export const instructorApi = {
  me: (signal?: AbortSignal) => request<InstructorStatus>('GET', '/api/instructor/me', { signal }),
  login: (password: string) => request<void>('POST', '/api/instructor/login', { body: { password } }),
  logout: () => request<void>('POST', '/api/instructor/logout'),
  attempts: (signal?: AbortSignal) => request<AttemptSummary[]>('GET', '/api/instructor/attempts', { signal }),
  attempt: (id: string, signal?: AbortSignal) =>
    request<AttemptDetail>('GET', `/api/instructor/attempts/${encodeURIComponent(id)}`, { signal }),
};
