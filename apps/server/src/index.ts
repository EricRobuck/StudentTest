import { createServer } from 'node:http';
import { TERMINAL_CLOSE } from '@linuxlab/shared';
import { createApp } from './app.js';
import { config } from './config.js';
import { AttemptService } from './modules/attempts/attemptService.js';
import { CommandLogService } from './modules/commandLog/commandLogService.js';
import { createDockerRuntime, startReaper } from './modules/containers/index.js';
import { createSqliteRepositories, openDatabase } from './modules/db/index.js';
import { getActiveExam, getExamById } from './modules/exams/examService.js';
import { InstructorAuth } from './modules/instructor/instructorAuth.js';
import { InstructorService } from './modules/instructor/instructorService.js';
import { SessionManager } from './modules/sessions/sessionManager.js';
import { SnapshotService } from './modules/snapshots/snapshotService.js';
import { TerminalHub } from './modules/terminal/terminalHub.js';
import { attachTerminalSocket } from './modules/terminal/terminalSocket.js';

const db = openDatabase(config.databasePath);
const repos = createSqliteRepositories(db);
const runtime = createDockerRuntime(config.containers);
const attempts = new AttemptService(repos, getExamById);
const sessions = new SessionManager(runtime, repos, attempts, getActiveExam);
const commandLog = new CommandLogService(repos);
const hub = new TerminalHub(runtime, config.terminal, {
  onActivity: (id) => void sessions.touch(id),
  onCommand: (id, command) => commandLog.record(id, command),
});
sessions.onEnvironmentEnded((sessionId, reason) =>
  hub.closeSession(sessionId, TERMINAL_CLOSE.ENDED, `Environment ended (${reason})`),
);

// Snapshot the student's files before a finished exam's container is removed.
const snapshots = new SnapshotService(runtime, repos);
sessions.beforeExamEnvironmentRemoved((attemptId, sessionId, containerId) =>
  snapshots.capture(attemptId, sessionId, containerId),
);

const instructorAuth = new InstructorAuth(config.security.instructorPassword);
const instructor = new InstructorService(repos, attempts, getExamById);

const server = createServer(createApp({ runtime, sessions, attempts, instructorAuth, instructor }));
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
  console.log(
    instructorAuth.enabled
      ? `[instructor] instructor pages at ${config.webUrl}/instructor`
      : '[instructor] DISABLED: set INSTRUCTOR_PASSWORD (e.g. in .env) to enable the instructor pages',
  );
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
    void commandLog.flush().finally(() => {
      db.close();
      process.exit(0);
    });
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
