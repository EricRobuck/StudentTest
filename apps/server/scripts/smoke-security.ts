// Phase 10 verification: behave like a student trying to break things.
//
//   npm run smoke:security                      container attacks only
//   npm run smoke:security -- <baseUrl> <db>    + attacks on a running backend
//
// For the rate-limit checks start the backend with NEW_SESSIONS_PER_IP=5.

import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { AttemptView } from '@linuxlab/shared';
import { config } from '../src/config.js';
import { createDockerRuntime, type ExecOptions } from '../src/modules/containers/index.js';
import { createHttpClient, createReporter, openTerminal, ORIGIN } from './lib/testClient.js';

const base = process.argv[2];
const dbPath = process.argv[3];
const runtime = createDockerRuntime(config.containers);
const { report, finish } = createReporter();

async function containerAttacks(): Promise<void> {
  console.log('--- Escaping / escalating from inside a container ---');
  const c = await runtime.createSessionContainer(`sec-${randomUUID().slice(0, 8)}`);
  const other = await runtime.createSessionContainer(`sec-${randomUUID().slice(0, 8)}`);
  const asStudent = (script: string, opts: ExecOptions = {}) =>
    runtime.exec(c.containerId, ['/bin/bash', '-c', script], { user: 'student', timeoutMs: 15_000, ...opts });

  try {
    const expectFail = async (name: string, script: string) => {
      const r = await asStudent(script);
      report(r.exitCode !== 0, name, `exit ${r.exitCode}: ${r.stdout.trim()} ${r.stderr.trim()}`.slice(0, 300));
    };
    await expectFail('Cannot create user namespaces (unshare -r)', 'unshare -r id');
    await expectFail('Cannot mount filesystems', 'mount -t tmpfs none /mnt');
    await expectFail('Cannot change kernel settings (/proc/sys)', 'echo 1 > /proc/sys/vm/drop_caches');
    await expectFail('Cannot become root with su', 'su -c id root </dev/null');
    await expectFail('No network: cannot reach the internet', 'timeout 3 bash -c "echo > /dev/tcp/1.1.1.1/80"');
    await expectFail('No network: cannot reach the host / cloud metadata', 'timeout 3 bash -c "echo > /dev/tcp/169.254.169.254/80"');
    await expectFail('Cannot read root-only files', 'cat /etc/shadow');
    await expectFail('Cannot tamper with the command-logging hook', 'echo x >> /etc/linuxlab/command-hook.sh');

    // Every directory the student can write to must be memory-backed (tmpfs), not the host's disk.
    const writable = await asStudent(
      'find / \\( -path /proc -o -path /sys -o -path /dev \\) -prune -o -type d -writable -print 2>/dev/null ' +
        '| while read -r d; do echo "$(stat -f -c %T "$d") $d"; done | grep -v "^tmpfs " | head -5',
    );
    report(writable.stdout.trim() === '', 'Every student-writable folder is size-limited memory, not the host disk', writable.stdout.trim());

    const disk = await asStudent('for i in 1 2 3; do dd if=/dev/zero of=$HOME/fill$i bs=1M count=40 status=none || { echo STOPPED_AT_$i; break; }; done; du -sm $HOME | cut -f1');
    report(/STOPPED_AT_2/.test(disk.stdout), 'Filling the home folder stops at its 64 MB limit', disk.stdout.trim());
    await asStudent('rm -f $HOME/fill*');

    const script = await asStudent('printf "#!/bin/bash\\necho script-ran\\n" > /tmp/s.sh && chmod 755 /tmp/s.sh && /tmp/s.sh');
    report(script.stdout.trim() === 'script-ran', 'Students can run their own scripts in /tmp (chmod 755; ./s.sh)');

    const mem = await asStudent('head -c 600M /dev/zero | tail > /dev/null; echo "exit=${PIPESTATUS[1]}"');
    const stillAlive = await asStudent('echo alive');
    report(/exit=137/.test(mem.stdout) && stillAlive.stdout.trim() === 'alive',
      'Using too much memory kills only that program (container survives)', mem.stdout.trim());

    await asStudent(':(){ :|:& };: ; sleep 4', { timeoutMs: 8000 });
    const neighbour = await runtime.exec(other.containerId, ['echo', 'neighbour-ok'], { user: 'student' });
    report(neighbour.stdout.trim() === 'neighbour-ok', "Fork bomb is contained: another student's container is unaffected");
    const own = await runtime.exec(c.containerId, ['true'], { user: 'root', timeoutMs: 5000 }).catch(() => null);
    console.log(`      (note) after the fork bomb its own container can${own?.exitCode === 0 ? '' : ' NOT'} run new processes`);
  } finally {
    await runtime.destroy(c.containerId);
    await runtime.destroy(other.containerId);
  }
}

async function serverAttacks(): Promise<void> {
  if (!base || !dbPath) return;
  console.log('\n--- Attacking the server ---');

  const health = await fetch(`${base}/api/health`);
  report(
    health.headers.get('x-content-type-options') === 'nosniff' &&
      health.headers.get('x-frame-options') === 'DENY' &&
      health.headers.get('cache-control') === 'no-store',
    'Security headers on API responses (nosniff, no framing, no caching)',
  );

  // The student used for the later checks (created before the limit is used up).
  const student = createHttpClient(base);
  const first = await student.call('POST', '/api/session');
  if (first.status !== 200) {
    report(false, `Could not create a session for the checks (${first.status})`);
    return;
  }
  const attemptId = (await student.call<AttemptView>('GET', '/api/attempt')).body.id;

  // Container creation is the expensive, abusable operation.
  const statuses: number[] = [];
  for (let i = 0; i < 7; i++) statuses.push((await createHttpClient(base).call('POST', '/api/session')).status);
  report(statuses.includes(429), `Creating many new sessions from one address is rate limited (${statuses.join(',')})`);
  report((await student.call('POST', '/api/session')).status === 200, 'Resuming an existing session is never rate limited');

  const submits: number[] = [];
  for (let i = 0; i < 40; i++) submits.push((await student.call('POST', '/api/exam/questions/q2-create-directory/submit')).status);
  report(submits.includes(429), `Rapid repeated submissions are rate limited (${submits.filter((s) => s === 429).length}/40 refused)`);

  const term = openTerminal(base, { Origin: ORIGIN, Cookie: student.cookie });
  await term.opened;
  await term.waitFor(/student@linux:~\$ $/m);
  // Forge thousands of command-log markers as fast as possible.
  term.type(`for i in $(seq 1 3000); do printf '\\e]7337;v2;cmd;%d;Lw==;ZmFrZQ==\\a' $((i+100000)); done; echo FLOOD-DONE\r`);
  await term.waitFor(/\nFLOOD-DONE\n/, 30_000);
  term.type('timeout 3 yes > /dev/tty; echo AFTER-FLOOD\r');
  const responsive = await term.waitFor(/\nAFTER-FLOOD\n/, 20_000);
  report(responsive, 'Terminal stays responsive after flooding output (`yes`)');
  await new Promise((r) => setTimeout(r, 1500));
  term.ws.close();

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db.prepare('SELECT flags FROM command_log WHERE attempt_id = ?').all(attemptId) as Array<{ flags: string }>;
  db.close();
  report(rows.length < 300 && rows.some((r) => r.flags.includes('log-flood')),
    `Forged command-log flood is capped and flagged (${rows.length} rows stored for ~3000 forged)`);

  const bigBody = await fetch(`${base}/api/attempt/current-question`, {
    method: 'PUT',
    headers: { Origin: ORIGIN, Cookie: student.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ questionId: 'x'.repeat(200_000) }),
  });
  report(bigBody.status === 413, `Oversized request bodies are refused (${bigBody.status})`);

  const badJson = await fetch(`${base}/api/attempt/current-question`, {
    method: 'PUT',
    headers: { Origin: ORIGIN, Cookie: student.cookie, 'Content-Type': 'application/json' },
    body: '{not json',
  });
  const badBody = await badJson.text();
  report(badJson.status === 400 && !/at |node_modules|Error:/.test(badBody), 'Malformed JSON gets a clean 400 (no stack traces)');
}

async function main(): Promise<void> {
  await containerAttacks();
  await serverAttacks();
  finish();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
