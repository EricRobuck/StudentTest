// A TerminalTransport carries bytes between the xterm.js view and a shell.
// The view never knows where the shell lives. The real implementation is
// webSocketTransport.ts (Bash inside the student's container); other lab
// types could supply a different transport without changing the view.

export type TerminalStatus = 'connecting' | 'connected' | 'disconnected';

export interface TerminalTransportHandlers {
  /** Output from the shell, to be written to the screen. */
  onOutput(data: string | Uint8Array): void;
  onStatus(status: TerminalStatus, detail?: string): void;
  /** Clear the screen (sent before the server replays output after a reconnect). */
  onReset(): void;
}

export interface TerminalTransport {
  /** Human-readable label shown in the terminal toolbar. */
  readonly label: string;
  connect(handlers: TerminalTransportHandlers): void;
  /** Keystrokes / pasted text typed by the student. */
  sendInput(data: string): void;
  resize(cols: number, rows: number): void;
  dispose(): void;
}
