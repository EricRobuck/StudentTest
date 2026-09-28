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
      // Hold incoming messages (e.g. the first resize) until the bridge is
      // listening; otherwise they'd be dropped during the database lookup.
      ws.pause();
      void (async () => {
        const token = readCookie(req.headers.cookie, SESSION_COOKIE);
        const session = token ? await deps.sessions.findByToken(token) : undefined;
        if (!session) {
          // Upgrade first, then close with a code the client understands
          // ("create a session and try again"); a plain HTTP 401 is invisible to browsers.
          ws.close(TERMINAL_CLOSE.NO_SESSION, 'No session');
          return;
        }
        if (!session.containerId) {
          // Exam finished (or environment ended and not yet recreated via POST /api/session).
          ws.close(TERMINAL_CLOSE.NO_SESSION, 'No environment');
          return;
        }
        alive.set(ws, true);
        ws.on('pong', () => alive.set(ws, true));
        deps.hub.attach({ sessionId: session.id, containerId: session.containerId }, ws);
        ws.resume();
      })().catch((err: unknown) => {
        console.warn('[terminal] upgrade failed:', err);
        ws.close(1011, 'Server error');
      });
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
