import { createServer } from 'node:http';
import { TERMINAL_CLOSE } from '@linuxlab/shared';
import { createApp } from './app.js';
import { config } from './config.js';
import { AttemptService } from './modules/attempts/attemptService.js';
import { createDockerRuntime, startReaper } from './modules/containers/index.js';
import { createSqliteRepositories, openDatabase } from './modules/db/index.js';
import { getActiveExam, getExamById } from './modules/exams/examService.js';
import { SessionManager } from './modules/sessions/sessionManager.js';
import { TerminalHub } from './modules/terminal/terminalHub.js';
import { attachTerminalSocket } from './modules/terminal/terminalSocket.js';

const db = openDatabase(config.databasePath);
const repos = createSqliteRepositories(db);
const runtime = createDockerRuntime(config.containers);
const attempts = new AttemptService(repos, getExamById);
const sessions = new SessionManager(runtime, repos, attempts, getActiveExam);
const hub = new TerminalHub(runtime, config.terminal, (id) => void sessions.touch(id));
sessions.onEnvironmentEnded((sessionId, reason) =>
  hub.closeSession(sessionId, TERMINAL_CLOSE.ENDED, `Environment ended (${reason})`),
);

const server = createServer(createApp({ runtime, sessions, attempts }));
const terminalSocket = attachTerminalSocket(server, {
  sessions,
  hub,
  allowedOrigins: config.security.allowedOrigins,
  heartbeatMs: config.terminal.heartbeatSeconds * 1000,
});

// Removes containers that are past their lifetime or that no session owns.
const stopReaper = startReaper(runtime, {
  intervalMs: config.containers.reapIntervalSeconds * 1000,
  maxAgeMs: config.containers.maxLifetimeMinutes * 60 * 1000,
  orphanGraceMs: config.containers.orphanGraceSeconds * 1000,
  ownedContainerIds: () => sessions.ownedContainerIds(),
});

// Enforces exam deadlines and removes containers of long-idle sessions.
const stopSweep = sessions.startSweep({
  idleMs: config.sessions.idleTimeoutMinutes * 60 * 1000,
  intervalMs: config.sessions.sweepIntervalSeconds * 1000,
  isAttached: (id) => hub.isAttached(id),
});

server.listen(config.port, config.host, () => {
  console.log(`[server] API listening on http://${config.host}:${config.port}/api`);
  console.log(`[server] Open the exam app in your browser at ${config.webUrl}`);
  console.log(`[db] ${config.databasePath}`);
  console.log(`[exams] active exam "${getActiveExam().title}" in ${getActiveExam().settings.mode} mode`);
  void runtime.status().then((s) => {
    if (s.available && s.imagePresent) console.log(`[containers] Docker ready, image ${s.image}`);
    else console.warn(`[containers] NOT READY: ${s.message}`);
  });
});

function shutdown(signal: string): void {
  console.log(`[server] ${signal} received, shutting down`);
  stopReaper();
  stopSweep();
  hub.closeAll(1001, 'Server restarting');
  terminalSocket.close();
  // Containers are kept: sessions are in the database, so students reconnect
  // to the same environment when the server comes back.
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
