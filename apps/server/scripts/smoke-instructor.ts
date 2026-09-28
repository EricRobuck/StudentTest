// Phase 9 verification: instructor access control and the results views.
//
//   npm run smoke:instructor -- <baseUrl> <instructorPassword>
//
// The backend must be started with the same INSTRUCTOR_PASSWORD.

import type { AttemptDetail, AttemptSummary, AttemptView, InstructorStatus } from '@linuxlab/shared';
import { createHttpClient, createReporter, openTerminal, ORIGIN } from './lib/testClient.js';

const base = process.argv[2] ?? 'http://127.0.0.1:3001';
const password = process.argv[3] ?? '';
const { report, finish } = createReporter();

async function main(): Promise<void> {
  console.log('--- Access control ---');
  const teacher = createHttpClient(base);
  const me = (await teacher.call<InstructorStatus>('GET', '/api/instructor/me')).body;
  report(me.enabled && !me.authenticated, 'Instructor access enabled, not signed in yet');
  report((await teacher.call('GET', '/api/instructor/attempts')).status === 401, 'Attempts list refused without sign-in');

  // A student's session cookie must not unlock instructor data.
  const student = createHttpClient(base);
  await student.call('POST', '/api/session');
  report((await student.call('GET', '/api/instructor/attempts')).status === 401, 'Student session cannot see instructor data');

  const foreign = await fetch(`${base}/api/instructor/login`, {
    method: 'POST',
    headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  report(foreign.status === 403, 'Login from another website is refused (403)');

  const login = await teacher.call('POST', '/api/instructor/login', { password });
  report(login.status === 204 && /HttpOnly/i.test(login.setCookie) && /SameSite=Strict/i.test(login.setCookie),
    'Correct password signs in (HttpOnly, SameSite=Strict cookie)');

  const intruder = createHttpClient(base);
  const statuses: number[] = [];
  for (let i = 0; i < 6; i++) statuses.push((await intruder.call('POST', '/api/instructor/login', { password: 'wrong-password' })).status);
  report(statuses.slice(0, 5).every((s) => s === 401) && statuses[5] === 429, 'Wrong passwords refused; locked out after 5 failures',
    statuses.join(','));
  report((await teacher.call('GET', '/api/instructor/attempts')).status === 200, 'Signed-in instructor still works during a lockout');

  console.log('\n--- A student attempt ---');
  const attemptId = (await student.call<AttemptView>('GET', '/api/attempt')).body.id;
  const term = openTerminal(base, { Origin: ORIGIN, Cookie: student.cookie });
  await term.opened;
  await term.waitFor(/student@linux:~\$ $/m);
  const run = async (cmd: string) => {
    const marker = `OK${Math.random().toString(36).slice(2, 7)}`;
    term.type(`${cmd} && echo ${marker}\r`);
    await term.waitFor(new RegExp(`\\n${marker}\\n`));
  };
  await run('cd /etc');
  await student.call('POST', '/api/exam/questions/q1-navigate-etc/submit');
  await student.call('PUT', '/api/attempt/current-question', { questionId: 'q4-file-contents' });
  await run('mkdir -p /tmp/cybersecurity && echo "Linux is awesome" > /tmp/cybersecurity/test.txt');
  await student.call('POST', '/api/exam/questions/q4-file-contents/submit');
  await new Promise((r) => setTimeout(r, 1200)); // some time on Q4
  await student.call('POST', '/api/attempt/finish');

  console.log('\n--- Instructor views ---');
  const list = (await teacher.call<AttemptSummary[]>('GET', '/api/instructor/attempts')).body;
  const row = list.find((a) => a.id === attemptId);
  report(row?.status === 'completed' && row.score.earned === 20 && row.commandCount >= 2, 'Attempt listed: finished, 20/50, commands counted',
    JSON.stringify(row));

  let detail: AttemptDetail | undefined;
  for (let i = 0; i < 40; i++) {
    detail = (await teacher.call<AttemptDetail>('GET', `/api/instructor/attempts/${attemptId}`)).body;
    if (detail.snapshot) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const q1 = detail?.questions.find((q) => q.questionId === 'q1-navigate-etc');
  const q4 = detail?.questions.find((q) => q.questionId === 'q4-file-contents');
  report(q1?.submissions[0]?.rules[0]?.detail === 'cwd=/etc', 'Instructor sees grader detail students never see (cwd=/etc)');
  report(q1?.commands.some((c) => c.command.startsWith('cd /etc')) === true, 'Commands grouped under the question that was open');
  report((q4?.timeSpentSeconds ?? 0) >= 1, `Time spent on Q4 recorded (${q4?.timeSpentSeconds}s)`);
  const file = detail?.snapshot?.entries.find((e) => e.path === '/tmp/cybersecurity/test.txt');
  report(file?.type === 'file' && file.owner === 'student', 'Final filesystem snapshot lists the student\'s file', JSON.stringify(file));
  report(detail?.snapshot?.files.some((f) => f.path === '/tmp/cybersecurity/test.txt' && f.content.includes('Linux is awesome')) === true,
    'Snapshot includes small file contents');

  await teacher.call('POST', '/api/instructor/logout');
  report((await teacher.call('GET', '/api/instructor/attempts')).status === 401, 'Signed out: access refused again');
  finish();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
