// WebSocket protocol for the student terminal.
//
//   Binary frames  = raw terminal bytes (client → server: keystrokes,
//                    server → client: shell output).
//   Text frames    = JSON control messages defined below.

export const TERMINAL_WS_PATH = '/ws/terminal';

export const TERMINAL_LIMITS = {
  maxCols: 500,
  maxRows: 200,
  /** Largest single WebSocket message the server accepts (a big paste). */
  maxMessageBytes: 64 * 1024,
} as const;

export type TerminalClientMessage =
  | { type: 'resize'; cols: number; rows: number };

export type TerminalServerMessage =
  /** Sent on every (re)attach, just before recent output is replayed. The client clears its screen. */
  | { type: 'attached'; sessionId: string; resumed: boolean }
  /** The student's shell exited (e.g. they typed `exit`) and a new one was started. */
  | { type: 'shell-restarted' }
  | { type: 'error'; code: TerminalErrorCode; message: string };

export type TerminalErrorCode = 'SHELL_FAILED' | 'ENVIRONMENT_ENDED';

/** WebSocket close codes (4000–4999 are reserved for applications). */
export const TERMINAL_CLOSE = {
  /** No valid session cookie: the client should create/resume a session, then reconnect. */
  NO_SESSION: 4001,
  /** The same session was opened in another tab/window: do not auto-reconnect. */
  REPLACED: 4002,
  /** The session was ended by the server (idle timeout, exam over). */
  ENDED: 4003,
  /** The student left the test screen; the instructor must unlock the test. */
  LOCKED: 4004,
} as const;
