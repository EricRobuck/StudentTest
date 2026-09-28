// Prints the command history of exam attempts (until the instructor page
// exists in Phase 9).
//
//   npm run commands:show                 most recent attempt
//   npm run commands:show -- --all        every attempt
//   npm run commands:show -- <attemptId>  one attempt

import { config } from '../src/config.js';
import { openDatabase, createSqliteRepositories } from '../src/modules/db/index.js';

const arg = process.argv[2];
const db = openDatabase(config.databasePath);
const repos = createSqliteRepositories(db);

const attempts = db
  .prepare('SELECT id, started_at, status FROM exam_attempts ORDER BY started_at DESC')
  .all()
  .map((r) => ({ id: String(r.id), startedAt: String(r.started_at), status: String(r.status) }));

const selected =
  arg === '--all' ? attempts : arg ? attempts.filter((a) => a.id === arg) : attempts.slice(0, 1);

if (selected.length === 0) {
  console.log(arg ? `No attempt ${arg}.` : 'No exam attempts yet.');
}

for (const a of selected) {
  const commands = await repos.commands.listForAttempt(a.id);
  console.log(`\nAttempt ${a.id}  (${a.status}, started ${new Date(a.startedAt).toLocaleString()})`);
  console.log(`${commands.length} command(s)\n`);
  let lastQuestion: string | null | undefined;
  for (const c of commands) {
    if (c.questionId !== lastQuestion) {
      console.log(`  [${c.questionId ?? 'no question'}]`);
      lastQuestion = c.questionId;
    }
    const time = new Date(c.executedAt).toLocaleTimeString([], { hour12: false });
    // Blank = success, !N = failed with exit code N, ? = unknown (shell ended while it ran).
    const status = c.exitCode === 0 ? '   ' : c.exitCode === null ? '?  ' : `!${String(c.exitCode).padEnd(2)}`;
    const flag = c.flags.length ? `   ⚠ ${c.flags.join(', ')}` : '';
    console.log(`  ${time} ${status} ${c.cwd.padEnd(18)} $ ${c.command.replace(/\n/g, '\n' + ' '.repeat(35))}${flag}`);
  }
}

db.close();
