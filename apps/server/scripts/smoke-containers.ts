// Phase 3 verification: create a student container, check from the inside
// that every isolation setting is really in effect, then destroy it.
//
//   npm run smoke:containers            create → check → destroy
//   npm run smoke:containers -- --keep  leave the container running to inspect

import { randomUUID } from 'node:crypto';
import { config } from '../src/config.js';
import { createDockerRuntime, type ExecOptions } from '../src/modules/containers/index.js';

const keep = process.argv.includes('--keep');
const runtime = createDockerRuntime(config.containers);

interface Check {
  name: string;
  argv: string[];
  options?: ExecOptions;
  expect: (r: { stdout: string; exitCode: number | null; timedOut: boolean }) => boolean;
  expected: string;
}

const REQUIRED_COMMANDS = [
  'ls', 'cd', 'pwd', 'mkdir', 'rmdir', 'touch', 'cat', 'cp', 'mv', 'rm', 'grep', 'find',
  'head', 'tail', 'wc', 'chmod', 'echo', 'less', 'more', 'ps', 'whoami', 'which', 'whereis',
];

const checks: Check[] = [
  {
    name: 'Shell user is "student"',
    argv: ['whoami'],
    options: { user: 'student' },
    expect: (r) => r.stdout.trim() === 'student',
    expected: 'student',
  },
  {
    name: 'Grader can exec as root',
    argv: ['id', '-u'],
    options: { user: 'root' },
    expect: (r) => r.stdout.trim() === '0',
    expected: '0',
  },
  {
    name: 'Hostname',
    argv: ['hostname'],
    expect: (r) => r.stdout.trim() === 'linux',
    expected: 'linux',
  },
  {
    name: 'Starts in home directory',
    argv: ['pwd'],
    options: { user: 'student' },
    expect: (r) => r.stdout.trim() === '/home/student',
    expected: '/home/student',
  },
  {
    name: 'Network disabled (only loopback)',
    argv: ['ls', '/sys/class/net'],
    expect: (r) => r.stdout.trim() === 'lo',
    expected: 'lo',
  },
  {
    name: 'Student has zero capabilities',
    argv: ['grep', 'CapEff', '/proc/self/status'],
    options: { user: 'student' },
    expect: (r) => /CapEff:\s+0+$/.test(r.stdout.trim()),
    expected: 'CapEff: 0000000000000000',
  },
  {
    name: 'no-new-privileges enforced',
    argv: ['grep', 'NoNewPrivs', '/proc/self/status'],
    options: { user: 'student' },
    expect: (r) => /NoNewPrivs:\s+1/.test(r.stdout),
    expected: 'NoNewPrivs: 1',
  },
  {
    name: 'No setuid/setgid binaries',
    argv: ['find', '/', '-xdev', '-perm', '/6000', '-type', 'f'],
    options: { timeoutMs: 20_000 },
    expect: (r) => r.stdout.trim() === '',
    expected: '(none)',
  },
  {
    name: 'No Docker socket inside',
    argv: ['ls', '/var/run/docker.sock'],
    expect: (r) => r.exitCode !== 0,
    expected: 'not found',
  },
  {
    name: 'Process limit',
    argv: ['cat', '/sys/fs/cgroup/pids.max'],
    expect: (r) => r.stdout.trim() === String(config.containers.pidsLimit),
    expected: String(config.containers.pidsLimit),
  },
  {
    name: 'Memory limit',
    argv: ['cat', '/sys/fs/cgroup/memory.max'],
    expect: (r) => r.stdout.trim() === String(config.containers.memoryBytes),
    expected: String(config.containers.memoryBytes),
  },
  {
    name: 'Student cannot write system dirs',
    argv: ['touch', '/etc/hacked'],
    options: { user: 'student' },
    expect: (r) => r.exitCode !== 0,
    expected: 'permission denied',
  },
  {
    name: 'Student can create /tmp/cybersecurity',
    argv: ['mkdir', '/tmp/cybersecurity'],
    options: { user: 'student' },
    expect: (r) => r.exitCode === 0,
    expected: 'exit 0',
  },
  {
    name: 'Required commands installed',
    argv: [
      'bash', '-c',
      'for c in "$@"; do command -v "$c" >/dev/null || echo "missing:$c"; done',
      'check', ...REQUIRED_COMMANDS,
    ],
    options: { user: 'student' },
    expect: (r) => r.stdout.trim() === '',
    expected: '(nothing missing)',
  },
  {
    name: 'Exec timeout kills long commands',
    argv: ['sleep', '30'],
    options: { timeoutMs: 1000 },
    expect: (r) => r.timedOut,
    expected: 'timed out after 1s',
  },
];

async function main(): Promise<void> {
  const status = await runtime.status();
  if (!status.available || !status.imagePresent) {
    console.error(`Docker not ready: ${status.message}`);
    process.exit(1);
  }

  const sessionId = `smoke-${randomUUID().slice(0, 8)}`;
  console.log(`Creating container for session ${sessionId} ...`);
  const t0 = Date.now();
  const c = await runtime.createSessionContainer(sessionId);
  console.log(`Created ${c.name} (${c.containerId.slice(0, 12)}) in ${Date.now() - t0} ms\n`);

  let failures = 0;
  try {
    for (const check of checks) {
      const r = await runtime.exec(c.containerId, check.argv, check.options);
      const ok = check.expect(r);
      if (!ok) failures++;
      const got = r.timedOut ? 'timed out' : r.stdout.trim().split('\n').slice(0, 3).join(' | ') || `exit ${r.exitCode}`;
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${check.name}`);
      if (!ok) console.log(`        expected: ${check.expected}\n        got:      ${got} ${r.stderr.trim()}`);
    }
  } finally {
    if (keep) {
      console.log(`\n--keep: container left running. Open a shell in it with:`);
      console.log(`  docker exec -it ${c.name} bash`);
      console.log(`Remove it with: npm run containers:cleanup`);
    } else {
      await runtime.destroy(c.containerId);
      const stillThere = (await runtime.listManaged()).some((m) => m.containerId === c.containerId);
      if (stillThere) failures++;
      console.log(`\n${stillThere ? 'FAIL' : 'PASS'}  Container destroyed`);
    }
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
