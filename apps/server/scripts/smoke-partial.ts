// Partial credit: once a question is final and was never fully right, the
// student gets the share of checks passed (best try) × points.
//
//   npm run smoke:partial -- <baseUrl> <instructorPassword>

import type { AttemptDetail, ExamDetail, ExamResultView, InstructorQuestion, QuestionContent, SubmitResult } from '@linuxlab/shared';
import { createHttpClient, createReporter, openTerminal, ORIGIN, startStudent } from './lib/testClient.js';

const base = process.argv[2] ?? 'http://127.0.0.1:3001';
const password = process.argv[3] ?? '';
const { report, finish } = createReporter();

// Four checks, like "Create and Archive Notes".
const fourChecks = (dir: string): QuestionContent => ({
  title: `Notes in ${dir}`,
  text: `Create \`/home/student/${dir}/work/a.txt\` and \`/home/student/${dir}/archive/b.txt\`, both containing \`done\`.`,
  points: 10,
  category: 'Files',
  difficulty: 'beginner',
  setup: [],
  validation: {
    mode: 'all',
    rules: [
      { type: 'directory_exists', path: `/home/student/${dir}/work` },
      { type: 'directory_exists', path: `/home/student/${dir}/archive` },
      { type: 'file_contains', path: `/home/student/${dir}/work/a.txt`, text: 'done' },
      { type: 'file_contains', path: `/home/student/${dir}/archive/b.txt`, text: 'done' },
    ],
  },
  solution: [`mkdir -p /home/student/${dir}/work /home/student/${dir}/archive`, `echo done > /home/student/${dir}/work/a.txt`, `echo done > /home/student/${dir}/archive/b.txt`],
});

async function main(): Promise<void> {
  const teacher = createHttpClient(base);
  report((await teacher.call('POST', '/api/instructor/login', { password })).status === 204, 'Instructor signs in');
  const exam = (await teacher.call<ExamDetail>('POST', '/api/instructor/exams', { title: 'Partial credit test' })).body;
  const add = async (c: QuestionContent) =>
    (await teacher.call<InstructorQuestion>('POST', `/api/instructor/exams/${exam.id}/questions`, c)).body;
  const qa = await add(fourChecks('pa'));
  const qb = await add(fourChecks('pb'));
  const qc = await add(fourChecks('pc'));
  for (let i = 0; i < 120; i++) {
    const d = (await teacher.call<ExamDetail>('GET', `/api/instructor/exams/${exam.id}`)).body;
    if (d.questions.every((x) => x.verification.status === 'passed' || x.verification.status === 'failed')) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  for (const q of [qa, qb, qc]) await teacher.call('POST', `/api/instructor/exams/${exam.id}/questions/${q.id}/approve`);
  report((await teacher.call('POST', `/api/instructor/exams/${exam.id}/enable`)).status === 200, 'Test exam with 4-check questions is open');

  const s = createHttpClient(base);
  await startStudent(s, 'Ada Partial', exam.id);
  const term = openTerminal(base, { Origin: ORIGIN, Cookie: s.cookie });
  await term.opened;
  await term.waitFor(/student@linux:~\$ $/m);
  const run = async (command: string) => {
    const marker = `DONE${Math.random().toString(36).slice(2, 7)}`;
    term.type(`${command}; echo ${marker}\r`);
    await term.waitFor(new RegExp(`\\n${marker}\\n`));
  };
  const submit = async (id: string) => (await s.call<SubmitResult>('POST', `/api/exam/questions/${id}/submit`)).body;

  console.log('--- Out of tries with 3 of 4 checks ---');
  // Like the real case: the archive file has the wrong name.
  await run('mkdir -p ~/pa/work ~/pa/archive && echo done > ~/pa/work/a.txt && echo done > ~/pa/archive/wrong-name.txt');
  let r = await submit(qa.id);
  report(r.feedback?.passed === false && r.feedback.pointsAwarded === 0 && !r.feedback.partial,
    'Try 1 (3/4 checks): still "Not yet", no points shown while tries remain', JSON.stringify(r.feedback));
  r = await submit(qa.id);
  r = await submit(qa.id);
  report(r.feedback?.pointsAwarded === 0 && !r.feedback?.partial, 'Try 3 (3/4): still "Not yet" while a try remains', JSON.stringify(r.feedback));
  r = await submit(qa.id);
  report(r.feedback?.partial === true && r.feedback.pointsAwarded === 7.5 && r.score?.earned === 7.5,
    'Try 4 also 3/4: question closes with partial credit 7.5/10', JSON.stringify({ f: r.feedback, s: r.score }));
  report(r.progress.best?.partial === true && r.progress.best.pointsAwarded === 7.5, 'Progress shows the partial credit');

  console.log('\n--- A later correct answer earns full points ---');
  await run('mkdir -p ~/pb/work && echo done > ~/pb/work/a.txt');
  r = await submit(qb.id); // 2/4 on try 1
  await run('mkdir -p ~/pb/archive && echo done > ~/pb/archive/b.txt');
  r = await submit(qb.id); // correct on try 2 → full points
  report(r.feedback?.passed === true && r.feedback.pointsAwarded === 10 && r.progress.best?.pointsAwarded === 10,
    'Wrong (2/4) then correct on try 2: full 10/10', JSON.stringify(r.progress.best));

  console.log('\n--- Exam ends with tries left ---');
  await run('mkdir -p ~/pc/work');
  r = await submit(qc.id); // 1/4 on try 1
  report(r.feedback?.pointsAwarded === 0 && r.score?.earned === 17.5, 'While open: 0 for that question (score 7.5 + 10)', JSON.stringify(r.score));
  const fin = (await s.call<ExamResultView>('POST', '/api/attempt/finish')).body;
  const rc = fin.questions.find((x) => x.questionId === qc.id);
  report(rc?.partial === true && rc.pointsAwarded === 2.5 && fin.score.earned === 20,
    'After finishing: 1/4 checks = 2.5, total 20/30', JSON.stringify({ rc, score: fin.score }));

  const detail = (await teacher.call<AttemptDetail>('GET', `/api/instructor/attempts/${fin.questions.length ? (await s.call<{ id: string }>('GET', '/api/attempt')).body.id : ''}`)).body;
  const da = detail.questions.find((x) => x.questionId === qa.id);
  report(da?.partial === true && da.pointsAwarded === 7.5 && detail.summary.score.earned === 20, 'Instructor pages show the same partial credit');

  console.log('\n--- Setting off ---');
  const settings = { ...exam.settings, partialCredit: false };
  report((await teacher.call('PUT', `/api/instructor/exams/${exam.id}`, { title: exam.title, description: '', settings })).status === 200,
    'Instructor turns partial credit off');
  const s2 = createHttpClient(base);
  await startStudent(s2, 'Bob Nopartial', exam.id);
  const t2 = openTerminal(base, { Origin: ORIGIN, Cookie: s2.cookie });
  await t2.opened;
  await t2.waitFor(/student@linux:~\$ $/m);
  t2.type('mkdir -p ~/pa/work ~/pa/archive && echo done > ~/pa/work/a.txt; echo OK1\r');
  await t2.waitFor(/\nOK1\n/);
  for (let i = 0; i < 4; i++) await s2.call('POST', `/api/exam/questions/${qa.id}/submit`);
  const fin2 = (await s2.call<ExamResultView>('POST', '/api/attempt/finish')).body;
  report(fin2.score.earned === 0, 'With partial credit off, 3/4 checks earn 0', JSON.stringify(fin2.score));
  term.ws.close();
  t2.ws.close();
}

main()
  .catch((err: unknown) => report(false, 'unexpected error', err instanceof Error ? err.stack : String(err)))
  .finally(() => finish());
