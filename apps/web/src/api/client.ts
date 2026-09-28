import type { ApiError, HealthResponse, SessionResponse, StudentExam } from '@linuxlab/shared';

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: 'GET' | 'POST', path: string, signal?: AbortSignal): Promise<T> {
  // Same-origin requests send the httpOnly session cookie automatically.
  const res = await fetch(path, { method, signal, headers: { Accept: 'application/json' } });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ApiError | null;
    throw new ApiRequestError(
      res.status,
      body?.error.code ?? 'HTTP_ERROR',
      body?.error.message ?? `Request failed with status ${res.status}`,
    );
  }
  return (await res.json()) as T;
}

// Concurrent callers share one in-flight request, so two components (or
// React StrictMode's double mount) can't create two containers at once.
let sessionInFlight: Promise<SessionResponse> | null = null;

export const api = {
  health: (signal?: AbortSignal) => request<HealthResponse>('GET', '/api/health', signal),

  /** Resumes this browser's exam session or starts a new one (creates its container). */
  startSession(): Promise<SessionResponse> {
    sessionInFlight ??= request<SessionResponse>('POST', '/api/session').finally(() => {
      sessionInFlight = null;
    });
    return sessionInFlight;
  },

  /** The student's exam (questions only; answers never leave the server). */
  exam: (signal?: AbortSignal) => request<StudentExam>('GET', '/api/exam', signal),
};
