// Lock-on-leave verification: a student who leaves the test screen is locked
// out until the instructor unlocks the test.
//
//   npm run smoke:lock -- <baseUrl> <instructorPassword>
//
// The backend must be started with the same INSTRUCTOR_PASSWORD.

import { TERMINAL_CLOSE, type AttemptDetail, type AttemptSummary, type AttemptView, type ExamDetail } from '@linuxlab/shared';
import { createHttpClient, createReporter, openTerminal, ORIGIN, startStudent } from './lib/testClient.js';

const base = process.argv[2] ?? 'http://127.0.0.1:3001';
const password = process.argv[3] ?? '';
const EXAM_ID = 'linux-basics-sample';
const { report, finish } = createReporter();

const within = (p: Promise<number>, ms = 5000) =>
  Promise.race([p, new Promise<number>((r) => setTimeout(() => r(-1), ms))]);

async function main(): Promise<void> {
  const teacher = createHttpClient(base);
  report((await teacher.call('POST', '/api/instructor/login', { password })).status === 204, 'Instructor signs in');

  console.log('--- Leaving the screen locks the test ---');
  const student = createHttpClient(base);
  await startStudent(student, 'Grace Hopper', EXAM_ID);
  const before = (await student.call<AttemptView>('GET', '/api/attempt')).body;
  report(before.locked === null, 'A new attempt is not locked');

  const term = openTerminal(base, { Origin: ORIGIN, Cookie: student.cookie });
  await term.opened;
  await term.waitFor(/student@linux:~\$ $/m);

  const foreign = await fetch(`${base}/api/attempt/left`, {
    method: 'POST',
    headers: { Origin: 'https://evil.example', Cookie: student.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'x' }),
  });
  report(foreign.status === 403, 'Another website cannot lock a student out (403)');

  const left = await student.call<AttemptView>('POST', '/api/attempt/left', { reason: 'switched tabs or minimized the browser' });
  report(left.status === 200 && left.body.locked?.reason === 'switched tabs or minimized the browser', 'Leaving locks the test',
    JSON.stringify(left.body));
  const code = await within(term.closed);
  report(code === TERMINAL_CLOSE.LOCKED, `Open terminal is closed as locked (${code})`);

  const again = openTerminal(base, { Origin: ORIGIN, Cookie: student.cookie });
  const againCode = await within(again.closed);
  report(againCode === TERMINAL_CLOSE.LOCKED, `A new terminal is refused while locked (${againCode})`);

  const submit = await student.call<{ error: { code: string } }>('POST', '/api/exam/questions/q1-navigate-etc/submit');
  report(submit.status === 409 && submit.body.error.code === 'TEST_LOCKED', 'Submitting is refused while locked', JSON.stringify(submit));
  const fin = await student.call<{ error: { code: string } }>('POST', '/api/attempt/finish');
  report(fin.status === 409 && fin.body.error.code === 'TEST_LOCKED', 'Finishing is refused while locked', JSON.stringify(fin));

  // Leaving again while locked (e.g. closing the page) is not a second event.
  await student.call('POST', '/api/attempt/left', { reason: 'closed or refreshed the test page' });
  const resumed = await student.call<{ attemptStatus: string }>('POST', '/api/session');
  report(resumed.status === 200 && resumed.body.attemptStatus === 'in_progress', 'Refreshing keeps the attempt');
  report((await student.call<AttemptView>('GET', '/api/attempt')).body.locked !== null, 'Still locked after refresh');

  console.log('\n--- Instructor sees it and unlocks ---');
  const attemptId = before.id;
  report((await student.call('POST', `/api/instructor/attempts/${attemptId}/unlock`)).status === 401, 'Students cannot unlock themselves');
  const list = (await teacher.call<AttemptSummary[]>('GET', '/api/instructor/attempts')).body;
  const row = list.find((a) => a.id === attemptId);
  report(!!row?.lockedAt && row.timesLeft === 1 && row.lockReason === 'switched tabs or minimized the browser',
    'Attempt list shows the lock, the reason and times left', JSON.stringify(row));

  const unlock = await teacher.call('POST', `/api/instructor/attempts/${attemptId}/unlock`);
  report(unlock.status === 204, 'Instructor unlocks the test');
  report((await student.call<AttemptView>('GET', '/api/attempt')).body.locked === null, 'Student is unlocked');

  const term2 = openTerminal(base, { Origin: ORIGIN, Cookie: student.cookie });
  await term2.opened;
  report(await term2.waitFor(/student@linux:~\$ $/m), 'Terminal works again after unlock');
  term2.type('cd /etc\r');
  await term2.waitFor(/student@linux:\/etc\$ $/m);
  const ok = await student.call<{ feedback: { passed: boolean } }>('POST', '/api/exam/questions/q1-navigate-etc/submit');
  report(ok.status === 200 && ok.body.feedback.passed, 'Submitting works again after unlock', JSON.stringify(ok));

  const detail = (await teacher.call<AttemptDetail>('GET', `/api/instructor/attempts/${attemptId}`)).body;
  report(detail.integrityEvents.map((e) => e.type).join(',') === 'left,unlocked', 'Lock and unlock are both logged with times',
    JSON.stringify(detail.integrityEvents));
  term2.ws.close();

  console.log('\n--- A test with the setting off ---');
  const exam = (await teacher.call<ExamDetail>('GET', `/api/instructor/exams/${EXAM_ID}`)).body;
  const save = (lockOnLeave: boolean) =>
    teacher.call('PUT', `/api/instructor/exams/${EXAM_ID}`, {
      title: exam.title,
      description: exam.description ?? '',
      settings: { ...exam.settings, lockOnLeave },
    });
  const off = await save(false);
  report(off.status === 200, 'Instructor turns off "lock if the student leaves"', JSON.stringify(off.body));
  const relaxed = createHttpClient(base);
  await startStudent(relaxed, 'Alan Turing', EXAM_ID);
  const exam2 = (await relaxed.call<{ rules: { lockOnLeave: boolean } }>('GET', '/api/exam')).body;
  report(exam2.rules.lockOnLeave === false, 'Student page is told the test does not lock');
  const relaxedLeft = await relaxed.call<AttemptView>('POST', '/api/attempt/left', { reason: 'switched tabs' });
  report(relaxedLeft.status === 200 && relaxedLeft.body.locked === null, 'Leaving does not lock that test');
  report((await save(true)).status === 200, 'Setting restored');

  console.log('\n--- Deleting attempts ---');
  const relaxedId = (await relaxed.call<AttemptView>('GET', '/api/attempt')).body.id;
  const liveTerm = openTerminal(base, { Origin: ORIGIN, Cookie: relaxed.cookie });
  await liveTerm.opened;
  await liveTerm.waitFor(/student@linux:~\$ $/m);
  report((await student.call('DELETE', `/api/instructor/attempts/${relaxedId}`)).status === 401, 'Students cannot delete attempts');
  const del = await teacher.call('DELETE', `/api/instructor/attempts/${relaxedId}`);
  report(del.status === 204, 'Instructor deletes an attempt that is still in progress');
  const liveCode = await within(liveTerm.closed);
  report(liveCode === TERMINAL_CLOSE.ENDED, `That student's terminal is closed (${liveCode})`);
  const gone = await relaxed.call<{ error: { code: string } }>('POST', '/api/session');
  report(gone.status === 401 && gone.body.error.code === 'NO_SESSION', 'That student is sent back to the start screen');
  report((await teacher.call('GET', `/api/instructor/attempts/${relaxedId}`)).status === 404, 'Deleted attempt is gone');
  report((await teacher.call('DELETE', `/api/instructor/attempts/${relaxedId}`)).status === 404, 'Deleting it again: 404');

  // An attempt with submissions, commands and lock events.
  report((await teacher.call('DELETE', `/api/instructor/attempts/${attemptId}`)).status === 204, 'Attempt with submissions, commands and locks deleted');
  const after = (await teacher.call<AttemptSummary[]>('GET', '/api/instructor/attempts')).body;
  report(!after.some((a) => a.id === attemptId || a.id === relaxedId), 'Neither appears in the attempt list');
}

main()
  .catch((err: unknown) => report(false, 'unexpected error', err instanceof Error ? err.stack : String(err)))
  .finally(() => finish());
