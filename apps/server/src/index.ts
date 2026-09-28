import { createServer } from 'node:http';
import { TERMINAL_CLOSE } from '@linuxlab/shared';
import { createApp } from './app.js';
import { config } from './config.js';
import { createDockerRuntime, startReaper } from './modules/containers/index.js';
import { SessionManager } from './modules/sessions/sessionManager.js';
import { TerminalHub } from './modules/terminal/terminalHub.js';
import { attachTerminalSocket } from './modules/terminal/terminalSocket.js';

const runtime = createDockerRuntime(config.containers);
const sessions = new SessionManager(runtime);
const hub = new TerminalHub(runtime, config.terminal, (id) => sessions.touch(id));
sessions.onEnded((session, reason) =>
  hub.closeSession(session.id, TERMINAL_CLOSE.ENDED, `Session ended (${reason})`),
);

const server = createServer(createApp({ runtime, sessions }));
const terminalSocket = attachTerminalSocket(server, {
  sessions,
  hub,
  allowedOrigins: config.security.allowedOrigins,
  heartbeatMs: config.terminal.heartbeatSeconds * 1000,
});

// Removes containers that are past their lifetime or that no session owns
// (e.g. left over from before a server restart, since sessions are in memory).
const stopReaper = startReaper(runtime, {
  intervalMs: config.containers.reapIntervalSeconds * 1000,
  maxAgeMs: config.containers.maxLifetimeMinutes * 60 * 1000,
  orphanGraceMs: config.containers.orphanGraceSeconds * 1000,
  isOwned: (containerId) => sessions.ownsContainer(containerId),
});

const stopIdleSweep = sessions.startIdleSweep({
  idleMs: config.sessions.idleTimeoutMinutes * 60 * 1000,
  intervalMs: config.sessions.sweepIntervalSeconds * 1000,
  isAttached: (id) => hub.isAttached(id),
});

server.listen(config.port, config.host, () => {
  console.log(`[server] API listening on http://${config.host}:${config.port}/api`);
  console.log(`[server] Open the exam app in your browser at ${config.webUrl}`);
  void runtime.status().then((s) => {
    if (s.available && s.imagePresent) console.log(`[containers] Docker ready, image ${s.image}`);
    else console.warn(`[containers] NOT READY: ${s.message}`);
  });
});

function shutdown(signal: string): void {
  console.log(`[server] ${signal} received, shutting down`);
  stopReaper();
  stopIdleSweep();
  hub.closeAll(1001, 'Server restarting');
  terminalSocket.close();
  // Containers are not removed here. Until sessions are stored in the
  // database (Phase 7), the reaper removes them as orphans after a restart.
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
