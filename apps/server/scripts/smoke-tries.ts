// Three-tries rule: a correct answer earns 100% / 90% / 60% of the points on
// try 1 / 2 / 3; three wrong answers earn 0 and close the question.
//
//   npm run smoke:tries -- <baseUrl>

import type { AttemptView, StudentExam, SubmitResult } from '@linuxlab/shared';
import { createHttpClient, createReporter, openTerminal, ORIGIN, startStudent } from './lib/testClient.js';

const base = process.argv[2] ?? 'http://127.0.0.1:3001';
const { report, finish } = createReporter();

async function main(): Promise<void> {
  const http = createHttpClient(base);
  await startStudent(http, 'Katherine Johnson', 'linux-basics-sample');
  const exam = (await http.call<StudentExam>('GET', '/api/exam')).body;
  report(exam.rules.threeTries && exam.rules.maxAttemptsPerQuestion === 3, 'Test uses three tries per question');

  const term = openTerminal(base, { Origin: ORIGIN, Cookie: http.cookie });
  await term.opened;
  await term.waitFor(/student@linux:~\$ $/m);
  const run = async (command: string) => {
    const marker = `DONE-${Math.random().toString(36).slice(2, 8)}`;
    term.type(`${command}; echo ${marker}\r`);
    await term.waitFor(new RegExp(`\\n${marker}\\n`));
  };
  const submit = (id: string) => http.call<SubmitResult & { error?: { code: string } }>('POST', `/api/exam/questions/${id}/submit`);

  const start = (await http.call<AttemptView>('GET', '/api/attempt')).body;
  const q1 = start.questions.find((p) => p.questionId === 'q1-navigate-etc');
  report(q1?.nextTryPoints === 10 && q1.attemptsRemaining === 3, 'Before trying: 3 tries, a correct answer earns 10/10');

  console.log('--- Wrong, wrong, right → 60% ---');
  let r = (await submit('q1-navigate-etc')).body;
  report(r.feedback?.passed === false && r.feedback.pointsAwarded === 0 && r.progress.nextTryPoints === 9 && r.progress.attemptsRemaining === 2,
    'Try 1 wrong: 0 points, 2 tries left, next correct answer earns 9', JSON.stringify(r.progress));
  r = (await submit('q1-navigate-etc')).body;
  report(r.progress.nextTryPoints === 6 && r.progress.attemptsRemaining === 1, 'Try 2 wrong: 1 try left, next correct answer earns 6',
    JSON.stringify(r.progress));
  await run('cd /etc');
  r = (await submit('q1-navigate-etc')).body;
  report(r.feedback?.passed === true && r.feedback.pointsAwarded === 6 && r.score?.earned === 6, 'Try 3 correct: 6/10 (60%)', JSON.stringify(r));
  const again = await submit('q1-navigate-etc');
  report(again.status === 409 && again.body.error?.code === 'NO_ATTEMPTS_LEFT', 'No fourth try');

  console.log('\n--- Wrong, right → 90% ---');
  r = (await submit('q2-create-directory')).body;
  await run('mkdir -p /tmp/cybersecurity');
  r = (await submit('q2-create-directory')).body;
  report(r.feedback?.pointsAwarded === 9 && r.score?.earned === 15, 'Try 2 correct: 9/10 (90%)', JSON.stringify(r));

  console.log('\n--- Right first time → 100% ---');
  await run('echo "Linux is awesome" > /tmp/cybersecurity/test.txt');
  r = (await submit('q3-create-file')).body;
  report(r.feedback?.pointsAwarded === 10 && r.score?.earned === 25, 'Try 1 correct: 10/10', JSON.stringify(r));

  console.log('\n--- Three wrong → missed ---');
  for (let i = 0; i < 3; i++) r = (await submit('q5-permissions')).body;
  report(r.progress.attemptsRemaining === 0 && r.progress.locked && r.progress.nextTryPoints === null && r.progress.best?.pointsAwarded === 0,
    'Three wrong answers: 0 points and the question is closed', JSON.stringify(r.progress));
  await run('chmod 640 /tmp/cybersecurity/test.txt');
  const late = await submit('q5-permissions');
  report(late.status === 409, 'Fixing it afterwards cannot be submitted');

  const fin = await http.call<{ score: { earned: number; max: number } }>('POST', '/api/attempt/finish');
  report(fin.body.score.earned === 25, `Final score adds up (${fin.body.score.earned}/${fin.body.score.max})`);
  term.ws.close();
}

main()
  .catch((err: unknown) => report(false, 'unexpected error', err instanceof Error ? err.stack : String(err)))
  .finally(() => finish());
