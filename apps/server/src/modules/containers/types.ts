// The rest of the server talks to student environments only through this
// interface. Docker is the first implementation; other isolation backends
// (gVisor, a remote runner) or other lab types can implement it later.

export type ExecUser = 'root' | 'student';

export interface SessionContainer {
  containerId: string;
  name: string;
  sessionId: string;
  createdAt: Date;
  running: boolean;
}

export interface ExecOptions {
  /** Defaults to 'root' because exec is used by setup and grading, not by students. */
  user?: ExecUser;
  /** Hard limit; the process is killed inside the container when it expires. Default 10s. */
  timeoutMs?: number;
  /** Per-stream output cap. Default 64 KiB. Container output is untrusted. */
  maxOutputBytes?: number;
  workingDir?: string;
}

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

export interface RuntimeStatus {
  available: boolean;
  imagePresent: boolean;
  image: string;
  message?: string;
}

/** An interactive Bash process on a PTY inside a student container. */
export interface ShellHandle {
  write(data: Buffer): void;
  resize(cols: number, rows: number): Promise<void>;
  onData(listener: (chunk: Buffer) => void): void;
  /** Fires once, when the shell process ends or the connection to it drops. */
  onExit(listener: () => void): void;
  /** Flow control: stop/start reading output while the browser catches up. */
  pause(): void;
  resume(): void;
  /** Hangs up the PTY; Bash receives SIGHUP and exits. */
  close(): void;
}

export interface ContainerRuntime {
  status(): Promise<RuntimeStatus>;
  createSessionContainer(sessionId: string): Promise<SessionContainer>;
  isRunning(containerId: string): Promise<boolean>;
  /** Starts an interactive login shell as `student`. */
  attachShell(containerId: string, size: { cols: number; rows: number }): Promise<ShellHandle>;
  /** Runs a fixed argv (never a shell string built from input) inside the container. */
  exec(containerId: string, argv: readonly string[], options?: ExecOptions): Promise<ExecResult>;
  destroy(containerId: string): Promise<void>;
  /** This backend's containers; allInstances includes other backends' too (cleanup tools only). */
  listManaged(options?: { allInstances?: boolean }): Promise<SessionContainer[]>;
}

export class ContainerError extends Error {
  constructor(
    readonly code: 'DOCKER_UNAVAILABLE' | 'IMAGE_MISSING' | 'CAPACITY' | 'INVALID_INPUT' | 'DOCKER_ERROR',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}
