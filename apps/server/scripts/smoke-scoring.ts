// Phase 7 verification: scoring, persistence, exam rules, finish and time-out,
// driven over HTTP + WebSocket like a browser.
//
//   npm run smoke:scoring -- <baseUrl> [databasePath]
//
// Practice-mode server: checks best-score rules, progress, finish, results.
// Exam-mode server (SAMPLE_EXAM_MODE=exam): checks hidden feedback and attempt limits.
// With databasePath: also forces a deadline into the past to test time-out.

import { DatabaseSync } from 'node:sqlite';
import {
  TERMINAL_CLOSE,
  type AttemptView,
  type ExamResultView,
  type SessionResponse,
  type StudentExam,
  type SubmitResult,
} from '@linuxlab/shared';
import { createHttpClient, createReporter, openTerminal, ORIGIN } from './lib/testClient.js';

const base = process.argv[2] ?? 'http://127.0.0.1:3001';
const dbPath = process.argv[3];
const { report, finish } = createReporter();

const Q = {
  nav: 'q1-navigate-etc',
  dir: 'q2-create-directory',
  file: 'q3-create-file',
  text: 'q4-file-contents',
  perm: 'q5-permissions',
};

async function startStudent() {
  const http = createHttpClient(base);
  const session = await http.call<SessionResponse>('POST', '/api/session');
  const exam = (await http.call<StudentExam>('GET', '/api/exam')).body;
  const term = openTerminal(base, { Origin: ORIGIN, Cookie: http.cookie });
  await term.opened;
  term.ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 30 }));
  await term.waitFor(/student@linux:~\$ $/m);
  const run = async (command: string) => {
    const marker = `DONE-${Math.random().toString(36).slice(2, 8)}`;
    term.type(`${command}; echo ${marker}\r`);
    await term.waitFor(new RegExp(`\\n${marker}\\n`));
  };
  const submit = (id: string) => http.call<SubmitResult>('POST', `/api/exam/questions/${id}/submit`);
  return { http, session: session.body, exam, term, run, submit };
}

async function practiceMode(): Promise<void> {
  console.log('--- Practice mode ---');
  const s = await startStudent();
  let attempt = (await s.http.call<AttemptView>('GET', '/api/attempt')).body;
  const minutesLeft = (Date.parse(attempt.deadlineAt ?? '') - Date.parse(attempt.serverTime)) / 60_000;
  report(s.session.resumed === false && attempt.status === 'in_progress', 'New attempt started');
  report(minutesLeft > 44 && minutesLeft <= 45, `Server deadline set (${minutesLeft.toFixed(1)} min left)`);
  report(attempt.score?.earned === 0 && attempt.score.max === 50, 'Score starts at 0 / 50');

  await s.run('cd /etc');
  let r = (await s.submit(Q.nav)).body;
  report(r.feedback?.passed === true && r.score?.earned === 10, 'Q1 correct → 10/50', JSON.stringify(r));

  await s.run('cd /tmp && mkdir cybersecurity');
  r = (await s.submit(Q.nav)).body;
  report(r.feedback?.passed === false && r.progress.best?.passed === true && r.score?.earned === 10,
    'Re-checking Q1 after leaving /etc fails, but the best score (10) is kept', JSON.stringify(r));

  await s.run('touch cybersecurity/test.txt && echo "Linux is awesome" > cybersecurity/test.txt && chmod 640 cybersecurity/test.txt');
  for (const id of [Q.dir, Q.file, Q.text, Q.perm]) await s.submit(id);

  const put = await s.http.call('PUT', '/api/attempt/current-question', { questionId: Q.perm });
  report(put.status === 204, 'Current question saved on the server');

  // "Refresh": a new page load gets the same progress from the server.
  attempt = (await s.http.call<AttemptView>('GET', '/api/attempt')).body;
  report(attempt.score?.earned === 50 && attempt.currentQuestionId === Q.perm, 'After reload: 50/50 and still on Q5');
  report(attempt.questions.find((p) => p.questionId === Q.nav)?.attempts === 2, 'Attempts are counted (Q1: 2)');

  const fin = await s.http.call<ExamResultView>('POST', '/api/attempt/finish');
  report(fin.status === 200 && fin.body.score.earned === 50 && fin.body.percentage === 100, 'Finish → 50/50, 100%');

  const late = await s.submit(Q.dir);
  report(late.status === 409, 'Submitting after finishing is refused (409)');
  report((await s.term.closed) === TERMINAL_CLOSE.ENDED, 'Terminal is closed when the exam ends (4003)');
  const again = (await s.http.call<SessionResponse>('POST', '/api/session')).body;
  report(again.attemptStatus === 'completed', 'Returning browser sees the completed exam, not a new one');
  const result = await s.http.call<ExamResultView>('GET', '/api/attempt/result');
  report(result.status === 200 && result.body.questions.length === 5, 'Results available afterwards');

  if (dbPath) {
    console.log('\n--- Time limit ---');
    const t = await startStudent();
    const attemptId = (await t.http.call<AttemptView>('GET', '/api/attempt')).body.id;
    const db = new DatabaseSync(dbPath);
    db.prepare('UPDATE exam_attempts SET deadline_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), attemptId);
    db.close();
    const sub = await t.submit(Q.dir);
    report(sub.status === 409, 'Submitting after the deadline is refused (409)', JSON.stringify(sub.body));
    const res = await t.http.call<ExamResultView>('GET', '/api/attempt/result');
    report(res.status === 200 && res.body.endReason === 'time_expired', 'Attempt auto-completed as time_expired');
    report((await t.term.closed) === TERMINAL_CLOSE.ENDED, 'Terminal closed at time-out');
  }
}

async function examMode(): Promise<void> {
  console.log('--- Exam mode ---');
  const s = await startStudent();
  report(!s.exam.questions.some((q) => q.hint), 'No hints are sent in exam mode');
  const attempt = (await s.http.call<AttemptView>('GET', '/api/attempt')).body;
  report(attempt.score === null, 'Score hidden during the exam');

  await s.run('mkdir /tmp/cybersecurity');
  const r1 = (await s.submit(Q.dir)).body;
  report(r1.feedback === null && r1.score === null && r1.progress.best === null, 'Submission recorded without revealing the result');
  report(r1.progress.attemptsRemaining === 1, 'Attempts remaining: 1');
  const r2 = await s.submit(Q.dir);
  report(r2.status === 200 && r2.body.progress.locked, 'Second attempt allowed, then locked');
  const r3 = await s.submit(Q.dir);
  report(r3.status === 409, 'Third attempt refused (409)');

  const fin = await s.http.call<ExamResultView>('POST', '/api/attempt/finish');
  report(fin.body.score.earned === 10, 'Results revealed at the end (10/50)');
}

async function main(): Promise<void> {
  const exam = (await (async () => {
    const http = createHttpClient(base);
    await http.call('POST', '/api/session');
    return (await http.call<StudentExam>('GET', '/api/exam')).body;
  })());
  if (exam.mode === 'exam') await examMode();
  else await practiceMode();
  finish();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
