import {
  TERMINAL_CLOSE,
  TERMINAL_WS_PATH,
  type TerminalClientMessage,
  type TerminalServerMessage,
} from '@linuxlab/shared';
import { api } from '../api/client';
import type { TerminalTransport, TerminalTransportHandlers } from './transport';

const MAX_RECONNECT_DELAY_MS = 10_000;
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

/**
 * Connects the terminal to the real Bash shell in this student's container.
 *
 * Flow: POST /api/session (sets/validates the session cookie and makes sure
 * the container exists) → open WebSocket → server replays recent output →
 * live bytes both ways. Dropped connections reconnect automatically and land
 * in the same shell.
 */
export function createWebSocketTransport(): TerminalTransport {
  let handlers: TerminalTransportHandlers | null = null;
  let socket: WebSocket | null = null;
  let disposed = false;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let size = { cols: 80, rows: 24 };
  const encoder = new TextEncoder();

  const sendControl = (msg: TerminalClientMessage) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
  };

  const scheduleReconnect = () => {
    if (disposed) return;
    const delay = Math.min(1000 * 2 ** attempt, MAX_RECONNECT_DELAY_MS);
    attempt++;
    reconnectTimer = setTimeout(() => void connect(), delay);
  };

  const handleControl = (text: string) => {
    let msg: TerminalServerMessage;
    try {
      msg = JSON.parse(text) as TerminalServerMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case 'attached':
        attempt = 0;
        // The server is about to replay recent output; start from a clean screen.
        handlers?.onReset();
        handlers?.onStatus('connected', msg.resumed ? 'reconnected to your shell' : 'Bash in your container');
        break;
      case 'shell-restarted':
        handlers?.onOutput(`\r\n${DIM}[shell exited — started a new one]${RESET}\r\n`);
        break;
      case 'error':
        handlers?.onOutput(`\r\n${RED}${msg.message}${RESET}\r\n`);
        break;
    }
  };

  async function connect(): Promise<void> {
    if (disposed || !handlers) return;
    handlers.onStatus('connecting', attempt === 0 ? 'starting your Linux environment…' : 'reconnecting…');

    try {
      const session = await api.startSession();
      if (disposed) return;
      if (session.attemptStatus === 'completed') {
        handlers.onStatus('disconnected', 'the exam has ended');
        return;
      }
    } catch (err) {
      if (disposed) return;
      handlers.onStatus('disconnected', err instanceof Error ? err.message : String(err));
      scheduleReconnect();
      return;
    }

    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${scheme}://${window.location.host}${TERMINAL_WS_PATH}`);
    ws.binaryType = 'arraybuffer';
    socket = ws;

    ws.onopen = () => sendControl({ type: 'resize', ...size });
    ws.onmessage = (event: MessageEvent<ArrayBuffer | string>) => {
      if (typeof event.data === 'string') handleControl(event.data);
      else handlers?.onOutput(new Uint8Array(event.data));
    };
    ws.onclose = (event) => {
      if (socket !== ws) return;
      socket = null;
      if (disposed) return;
      switch (event.code) {
        case TERMINAL_CLOSE.REPLACED:
          handlers?.onStatus('disconnected', 'opened in another window — refresh to continue here');
          return;
        case TERMINAL_CLOSE.ENDED:
          handlers?.onStatus('disconnected', 'session ended — refresh to start again');
          return;
        default:
          handlers?.onStatus('disconnected', 'connection lost — reconnecting…');
          scheduleReconnect();
      }
    };
  }

  return {
    label: 'Linux terminal',
    connect(h) {
      handlers = h;
      void connect();
    },
    sendInput(data) {
      if (socket?.readyState === WebSocket.OPEN) socket.send(encoder.encode(data));
    },
    resize(cols, rows) {
      size = { cols, rows };
      sendControl({ type: 'resize', cols, rows });
    },
    dispose() {
      disposed = true;
      clearTimeout(reconnectTimer);
      socket?.close(1000, 'Terminal closed');
      socket = null;
      handlers = null;
    },
  };
}
