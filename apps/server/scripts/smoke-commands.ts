// Phase 8 verification: command logging, end to end.
//
//   npm run smoke:commands -- <baseUrl> <databasePath>
//
// Needs a backend running with the given database (to read the log back).

import { DatabaseSync } from 'node:sqlite';
import type { AttemptView } from '@linuxlab/shared';
import { CommandMarkerParser } from '../src/modules/terminal/commandMarkers.js';
import { createHttpClient, createReporter, openTerminal, ORIGIN, startStudent } from './lib/testClient.js';

const base = process.argv[2] ?? 'http://127.0.0.1:3001';
const dbPath = process.argv[3];
const { report, finish } = createReporter();

function parserUnitChecks(): void {
  console.log('--- Marker parser ---');
  const b64 = (s: string) => Buffer.from(s).toString('base64');
  const cmd = (n: number, cwd: string, c: string) => `\x1b]7337;v2;cmd;${n};${b64(cwd)};${b64(c)}\x07`;
  const exit = (n: number, status: number) => `\x1b]7337;v2;exit;${n};${status}\x07`;
  const text = `before${cmd(7, '/etc', 'ls -la')}listing${exit(7, 2)}after`;

  const p1 = new CommandMarkerParser();
  const r1 = p1.push(Buffer.from(text));
  const c1 = r1.commands[0];
  report(r1.output.toString() === 'beforelistingafter' && c1?.command === 'ls -la' && c1.cwd === '/etc' && c1.exitCode === 2,
    'Markers removed from output; command, directory and exit code decoded');

  // Split at every possible position: output and commands must be identical.
  let allSplitsOk = true;
  for (let i = 1; i < text.length; i++) {
    const p = new CommandMarkerParser();
    const a = p.push(Buffer.from(text.slice(0, i)));
    const b = p.push(Buffer.from(text.slice(i)));
    const out = a.output.toString() + b.output.toString();
    if (out !== 'beforelistingafter' || a.commands.length + b.commands.length !== 1) allSplitsOk = false;
  }
  report(allSplitsOk, 'Markers split across two chunks at any position are handled');

  const p2 = new CommandMarkerParser();
  const dup = p2.push(Buffer.from(cmd(3, '/', 'pwd') + exit(3, 0) + exit(3, 0) + cmd(3, '/', 'pwd')));
  report(dup.commands.length === 1, 'Repeated reports of the same history entry are logged once');
  const p2b = new CommandMarkerParser();
  const running = p2b.push(Buffer.from(cmd(4, '/', 'sleep 100')));
  report(running.commands.length === 0 && p2b.flush()[0]?.exitCode === null, 'A still-running command is reported when the shell ends');

  const p3 = new CommandMarkerParser();
  const bogus = '\x1b]7337;v2;cmd;x;not base64!;zz\x07visible';
  report(p3.push(Buffer.from(bogus)).output.toString() === 'visible' && p3.flush().length === 0,
    'Malformed marker is dropped, not logged');
  const p4 = new CommandMarkerParser();
  report(p4.push(Buffer.from('\x1b]0;window title\x07ok')).output.toString() === '\x1b]0;window title\x07ok',
    'Other escape sequences pass through untouched');
}

async function endToEnd(): Promise<void> {
  console.log('\n--- End to end ---');
  if (!dbPath) throw new Error('usage: smoke-commands <baseUrl> <databasePath>');
  const http = createHttpClient(base);
  await startStudent(http);
  const attempt = (await http.call<AttemptView>('GET', '/api/attempt')).body;
  const term = openTerminal(base, { Origin: ORIGIN, Cookie: http.cookie });
  await term.opened;
  term.ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 30 }));
  await term.waitFor(/student@linux:~\$ $/m);

  const prompts = () => (term.output.match(/student@linux:[^\n]*\$ /g) ?? []).length;
  const type = async (line: string) => {
    const before = prompts();
    term.type(`${line}\r`);
    const until = Date.now() + 8000;
    while (prompts() <= before && Date.now() < until) await new Promise((r) => setTimeout(r, 30));
  };

  await http.call('PUT', '/api/attempt/current-question', { questionId: 'q1-navigate-etc' });
  await type('pwd');
  await type('cd /etc');
  await type('ls /nope');
  await type('pwd');
  await type('');
  await type('pwd');
  await type(' echo spaced');
  await type('for i in 1 2; do\recho $i\rdone');
  await http.call('PUT', '/api/attempt/current-question', { questionId: 'q2-create-directory' });
  await type('mkdir /tmp/cybersecurity');
  await type('unset PROMPT_COMMAND');
  await type('__ll_cmd() { :; }');
  await type('echo still-logged');
  await type('exit'); // shell ends; the server starts a new one
  await new Promise((r) => setTimeout(r, 800));
  term.ws.close();

  report(!term.raw.includes('\x1b]7337'), 'No logging markers reach the browser');

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db
    .prepare('SELECT seq, question_id, command, cwd, exit_code, flags FROM command_log WHERE attempt_id = ? ORDER BY seq')
    .all(attempt.id) as Array<{ seq: number; question_id: string; command: string; cwd: string; exit_code: number; flags: string }>;
  db.close();

  const summary = rows.map((r) => `${r.cwd} $ ${r.command} [${r.exit_code}]`).join(' | ');
  const cmds = rows.map((r) => r.command);
  const expected = [
    'pwd', 'cd /etc', 'ls /nope', 'pwd', 'pwd', 'echo spaced', 'for i in 1 2; do echo $i; done',
    'mkdir /tmp/cybersecurity', 'unset PROMPT_COMMAND', '__ll_cmd() { :; }', 'echo still-logged', 'exit',
  ];
  report(JSON.stringify(cmds) === JSON.stringify(expected),
    'Every command logged once, in order (repeats, leading space, loops; empty Enter ignored)', summary);
  report(rows[1]?.cwd === '/home/student' && rows[2]?.cwd === '/etc', 'Working directory is where each command ran');
  report(rows[2]?.exit_code === 2 && rows[0]?.exit_code === 0, 'Exit codes recorded (ls /nope → 2)');
  report(rows[0]?.question_id === 'q1-navigate-etc' && rows[7]?.question_id === 'q2-create-directory',
    'Each command is linked to the question that was open');
  report(rows[8]?.flags === 'logging-tamper' && rows[9]?.flags === 'logging-tamper',
    'Attempts to disable logging are logged and flagged');
  report(rows[8]?.exit_code === 1 && rows[9]?.exit_code === 1, '...and they fail (hook is read-only)');
  report(cmds.includes('echo still-logged'), 'Logging continues after the tampering attempts');
  report(rows[11]?.command === 'exit' && rows[11].exit_code === null, '`exit` is logged even though its shell ended');
}

async function main(): Promise<void> {
  parserUnitChecks();
  await endToEnd();
  finish();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
