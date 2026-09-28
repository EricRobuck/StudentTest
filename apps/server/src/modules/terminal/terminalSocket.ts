import type { Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { TERMINAL_CLOSE, TERMINAL_LIMITS, TERMINAL_WS_PATH } from '@linuxlab/shared';
import { isAllowedOrigin, readCookie, SESSION_COOKIE } from '../../http/security.js';
import type { SessionManager } from '../sessions/sessionManager.js';
import type { TerminalHub } from './terminalHub.js';

export interface TerminalSocketDeps {
  sessions: SessionManager;
  hub: TerminalHub;
  allowedOrigins: readonly string[];
  heartbeatMs: number;
}

/**
 * Accepts WebSocket upgrades on /ws/terminal and hands each authenticated
 * connection to the TerminalHub. Every check happens server-side:
 * the Origin must be our web app and the session cookie must be valid.
 */
export function attachTerminalSocket(server: Server, deps: TerminalSocketDeps): { close(): void } {
  const wss = new WebSocketServer({ noServer: true, maxPayload: TERMINAL_LIMITS.maxMessageBytes });
  const alive = new WeakMap<WebSocket, boolean>();

  server.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path !== TERMINAL_WS_PATH) return rejectUpgrade(socket, 404, 'Not Found');
    // Blocks cross-site WebSocket hijacking: another website cannot open a
    // terminal using the student's cookie.
    if (!isAllowedOrigin(req.headers.origin, deps.allowedOrigins)) {
      return rejectUpgrade(socket, 403, 'Forbidden');
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const token = readCookie(req.headers.cookie, SESSION_COOKIE);
      const session = token ? deps.sessions.findByToken(token) : undefined;
      if (!session) {
        // Upgrade first, then close with a code the client understands
        // ("create a session and try again"); a plain HTTP 401 is invisible to browsers.
        ws.close(TERMINAL_CLOSE.NO_SESSION, 'No session');
        return;
      }
      alive.set(ws, true);
      ws.on('pong', () => alive.set(ws, true));
      deps.hub.attach(session, ws);
    });
  });

  // Detect dead connections (laptop lid closed, Wi-Fi dropped) so the session
  // is correctly seen as detached and can idle out.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.get(ws)) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, deps.heartbeatMs);
  heartbeat.unref();

  return {
    close() {
      clearInterval(heartbeat);
      wss.close();
    },
  };
}

function rejectUpgrade(socket: Duplex, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}
