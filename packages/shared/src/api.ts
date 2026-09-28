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
 * Response body of POST /api/session. The session itself is identified by an
 * httpOnly cookie that JavaScript never sees.
 */
export interface SessionResponse {
  sessionId: string;
  /** false when a brand-new Linux environment was just created. */
  resumed: boolean;
}

/** Uniform error body returned by every REST endpoint. */
export interface ApiError {
  error: {
    code: string;
    message: string;
  };
}
