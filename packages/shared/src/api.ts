import type { AttemptStatus } from './exam.js';
import type { StudentInfo } from './student.js';

/** Response body of GET /api/health. */
export interface HealthResponse {
  status: 'ok';
  service: string;
  version: string;
  /** ISO-8601 server time. The server clock is the only clock trusted for exam timers. */
  serverTime: string;
  uptimeSeconds: number;
  /** Whether student Linux environments can be created right now. */
  docker: DockerStatus;
}

export interface DockerStatus {
  available: boolean;
  imagePresent: boolean;
  /** Human-readable reason when something is not ready. */
  message?: string;
}

/**
 * Response body of POST /api/session (resume), POST /api/session/start and
 * POST /api/session/new-attempt. The session itself is identified by an
 * httpOnly cookie that JavaScript never sees. POST /api/session answers
 * 401 NO_SESSION when the browser has no session yet (show the start screen).
 */
export interface SessionResponse {
  sessionId: string;
  /** false when a brand-new session (and exam attempt) was just started. */
  resumed: boolean;
  attemptStatus: AttemptStatus;
  student: StudentInfo;
  /**
   * true when the previous Linux environment had ended (idle timeout, server
   * problem) and a fresh one was created: files from before are gone.
   */
  environmentReset: boolean;
}

/** Uniform error body returned by every REST endpoint. */
export interface ApiError {
  error: {
    code: string;
    message: string;
  };
}
