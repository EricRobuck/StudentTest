import { createServer } from 'node:http';
import { TERMINAL_CLOSE } from '@linuxlab/shared';
import { createApp } from './app.js';
import { config } from './config.js';
import { AttemptService } from './modules/attempts/attemptService.js';
import { AuthoringService } from './modules/authoring/authoringService.js';
import { QuestionGenerator } from './modules/authoring/questionGenerator.js';
import { CommandLogService } from './modules/commandLog/commandLogService.js';
import { createDockerRuntime, startReaper } from './modules/containers/index.js';
import { createSqliteRepositories, openDatabase } from './modules/db/index.js';
import { ExamCatalog } from './modules/exams/examCatalog.js';
import { examForAttempt, getOpenExam, getOpenExams, setExamCatalog } from './modules/exams/examService.js';
import { InstructorAuth } from './modules/instructor/instructorAuth.js';
import { InstructorService } from './modules/instructor/instructorService.js';
import { SessionManager } from './modules/sessions/sessionManager.js';
import { SnapshotService } from './modules/snapshots/snapshotService.js';
import { TerminalHub } from './modules/terminal/terminalHub.js';
import { attachTerminalSocket } from './modules/terminal/terminalSocket.js';

const db = openDatabase(config.databasePath);
const repos = createSqliteRepositories(db);
const runtime = createDockerRuntime(config.containers);

// Exams live in the database; load them before serving anyone.
const catalog = new ExamCatalog(repos.exams);
await catalog.load();
setExamCatalog(catalog);

const attempts = new AttemptService(repos, examForAttempt);
const sessions = new SessionManager(runtime, repos, attempts, getOpenExam, examForAttempt);
const commandLog = new CommandLogService(repos, config.security.rateLimits);
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
const instructor = new InstructorService(repos, attempts, examForAttempt);
const authoring = new AuthoringService(catalog, runtime, new QuestionGenerator(config.ai.model));

// Instructor deletes an attempt: stop its environments (closing the student's
// terminal), store any command reports still in flight, then remove the records.
async function deleteAttempt(attemptId: string): Promise<boolean> {
  for (const id of await sessions.sessionIdsOfAttempt(attemptId)) await sessions.endEnvironment(id, 'attempt-deleted');
  await commandLog.flush();
  const deleted = await repos.attempts.delete(attemptId);
  if (deleted) console.log(`[audit] attempt ${attemptId} deleted by instructor`);
  return deleted;
}

const server = createServer(
  createApp({ runtime, sessions, attempts, instructorAuth, instructor, authoring, deleteAttempt }),
);
const terminalSocket = attachTerminalSocket(server, {
  sessions,
  hub,
  allowedOrigins: config.security.allowedOrigins,
  heartbeatMs: config.terminal.heartbeatSeconds * 1000,
  isLocked: async (attemptId) => Boolean((await attempts.get(attemptId))?.lockedAt),
});

// A student who leaves the test screen loses their terminal until the instructor unlocks the test.
attempts.onLocked((attemptId) => {
  void sessions.sessionIdsOfAttempt(attemptId).then((ids) => {
    for (const id of ids) hub.closeSession(id, TERMINAL_CLOSE.LOCKED, 'Test locked');
  });
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
  const open = getOpenExams();
  console.log(
    open.length
      ? `[exams] open to students: ${open.map((e) => `"${e.title}" (${e.questions.length} questions)`).join(', ')}`
      : '[exams] NO OPEN TESTS: students cannot start until a test with approved questions is enabled',
  );
  console.log(
    authoring.aiStatus().enabled
      ? `[ai] AI question writing enabled (${config.ai.model})`
      : '[ai] AI question writing disabled: add OPENAI_API_KEY to .env to enable it',
  );
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
