// Limited tries: 4 tries per question, full points for a correct answer on
// any of them; after the 4th wrong answer the question closes.
//
//   npm run smoke:tries -- <baseUrl>

import { TRIES_PER_QUESTION, type AttemptView, type StudentExam, type SubmitResult } from '@linuxlab/shared';
import { createHttpClient, createReporter, openTerminal, ORIGIN, startStudent } from './lib/testClient.js';

const base = process.argv[2] ?? 'http://127.0.0.1:3001';
const { report, finish } = createReporter();

async function main(): Promise<void> {
  const http = createHttpClient(base);
  await startStudent(http, 'Katherine Johnson', 'linux-basics-sample');
  const exam = (await http.call<StudentExam>('GET', '/api/exam')).body;
  report(TRIES_PER_QUESTION === 4 && exam.rules.limitedTries && exam.rules.maxAttemptsPerQuestion === 4, 'Test uses 4 tries per question');

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
  report(start.questions.find((p) => p.questionId === 'q1-navigate-etc')?.attemptsRemaining === 4, 'Before trying: 4 tries left');

  console.log('--- Wrong three times, right on the 4th → full points ---');
  let r = (await submit('q1-navigate-etc')).body;
  report(r.feedback?.passed === false && r.feedback.pointsAwarded === 0 && r.progress.attemptsRemaining === 3, 'Try 1 wrong: 0 points, 3 tries left',
    JSON.stringify(r.progress));
  r = (await submit('q1-navigate-etc')).body;
  r = (await submit('q1-navigate-etc')).body;
  report(r.progress.attemptsRemaining === 1 && !r.progress.locked, 'Try 3 wrong: 1 try left', JSON.stringify(r.progress));
  await run('cd /etc');
  r = (await submit('q1-navigate-etc')).body;
  report(r.feedback?.passed === true && r.feedback.pointsAwarded === 10 && r.score?.earned === 10, 'Try 4 correct: full 10/10 (no deduction)', JSON.stringify(r));
  const again = await submit('q1-navigate-etc');
  report(again.status === 409 && again.body.error?.code === 'NO_ATTEMPTS_LEFT', 'No fifth try');

  console.log('\n--- Wrong once, then right → full points ---');
  await submit('q2-create-directory');
  await run('mkdir -p /tmp/cybersecurity');
  r = (await submit('q2-create-directory')).body;
  report(r.feedback?.pointsAwarded === 10 && r.score?.earned === 20, 'Try 2 correct: 10/10', JSON.stringify(r.feedback));

  console.log('\n--- Right first time ---');
  await run('echo "Linux is awesome" > /tmp/cybersecurity/test.txt');
  r = (await submit('q3-create-file')).body;
  report(r.feedback?.pointsAwarded === 10 && r.score?.earned === 30, 'Try 1 correct: 10/10', JSON.stringify(r.feedback));

  console.log('\n--- Four wrong → question closes ---');
  for (let i = 0; i < 4; i++) r = (await submit('q5-permissions')).body;
  report(r.progress.attemptsRemaining === 0 && r.progress.locked && r.progress.best?.pointsAwarded === 0,
    'Four wrong answers (single-check question): 0 points and the question is closed', JSON.stringify(r.progress));
  await run('chmod 640 /tmp/cybersecurity/test.txt');
  report((await submit('q5-permissions')).status === 409, 'Fixing it afterwards cannot be submitted');

  const fin = await http.call<{ score: { earned: number; max: number } }>('POST', '/api/attempt/finish');
  report(fin.body.score.earned === 30, `Final score adds up (${fin.body.score.earned}/${fin.body.score.max})`);
  term.ws.close();
}

main()
  .catch((err: unknown) => report(false, 'unexpected error', err instanceof Error ? err.stack : String(err)))
  .finally(() => finish());
