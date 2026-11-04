// Written tests (multiple choice, fill in the blank), instructor grade changes.
//
//   npm run smoke:written -- <baseUrl> <instructorPassword>

import {
  TERMINAL_CLOSE,
  type AttemptDetail,
  type AttemptSummary,
  type AttemptView,
  type ExamDetail,
  type ExamResultView,
  type InstructorQuestion,
  type QuestionContent,
  type QuestionProgress,
  type SessionResponse,
  type StudentExam,
} from '@linuxlab/shared';
import { createHttpClient, createReporter, openTerminal, ORIGIN, startStudent } from './lib/testClient.js';

const base = process.argv[2] ?? 'http://127.0.0.1:3001';
const password = process.argv[3] ?? '';
const { report, finish } = createReporter();

const common = { points: 10, category: 'Geography', difficulty: 'beginner', setup: [], validation: { mode: 'all', rules: [] }, solution: [] } as const;
const SECRET_CHOICE = 'Paris-is-the-capital';
const SECRET_ANSWER = 'Pacific-Ocean-Secret';
const mc = (over: Partial<QuestionContent> = {}): QuestionContent => ({
  ...common,
  setup: [],
  validation: { mode: 'all', rules: [] },
  solution: [],
  title: 'Capital of France',
  text: 'What is the capital of France?',
  answer: { type: 'multiple_choice', choices: ['Rome', SECRET_CHOICE, 'Madrid'], correctIndex: 1 },
  ...over,
});
const blank = (): QuestionContent => ({
  ...common,
  setup: [],
  validation: { mode: 'all', rules: [] },
  solution: [],
  title: 'Largest ocean',
  text: 'The largest ocean is the ____.',
  explanation: 'Never shown to students',
  answer: { type: 'fill_in_blank', accepted: [SECRET_ANSWER, 'The Pacific'] },
});

async function main(): Promise<void> {
  const teacher = createHttpClient(base);
  report((await teacher.call('POST', '/api/instructor/login', { password })).status === 204, 'Instructor signs in');

  console.log('--- Choosing the type when creating a test ---');
  const exam = (await teacher.call<ExamDetail>('POST', '/api/instructor/exams', { title: 'Written check', examType: 'written' })).body;
  report(exam.settings.examType === 'written' && exam.settings.mode === 'exam', 'New written test (one attempt)');
  const linuxExam = (await teacher.call<ExamDetail>('POST', '/api/instructor/exams', { title: 'Linux check' })).body;
  report(linuxExam.settings.examType !== 'written' && linuxExam.settings.mode === 'practice', 'Without choosing, a test is a Linux lab, as before');

  const addTo = (id: string, c: unknown) => teacher.call<InstructorQuestion>('POST', `/api/instructor/exams/${id}/questions`, c);
  report((await addTo(linuxExam.id, mc())).status === 400, 'A Linux lab refuses a written question');
  report((await addTo(exam.id, {
    ...mc(), answer: undefined, solution: ['true'], validation: { mode: 'all', rules: [{ type: 'file_exists', path: '/tmp/x' }] },
  })).status === 400, 'A written test refuses a Linux question');
  report((await addTo(exam.id, mc({ answer: { type: 'multiple_choice', choices: ['Only one'], correctIndex: 0 } }))).status === 400, 'Multiple choice needs at least 2 choices');
  report((await addTo(exam.id, mc({ answer: { type: 'multiple_choice', choices: ['A', 'B'], correctIndex: 5 } }))).status === 400, 'Correct choice must exist');
  report((await addTo(exam.id, mc({ answer: { type: 'fill_in_blank', accepted: [] } }))).status === 400, 'Fill in the blank needs an accepted answer');

  const qm = (await addTo(exam.id, mc())).body;
  const qb = (await addTo(exam.id, blank())).body;
  const qx = (await addTo(exam.id, { ...mc(), title: 'Left unanswered' })).body;
  report(qm.status === 'draft' && qm.verification.status === 'passed', 'Written question is a draft, ready to approve (no sandbox)');
  for (const q of [qm, qb, qx]) await teacher.call('POST', `/api/instructor/exams/${exam.id}/questions/${q.id}/approve`);
  report((await teacher.call('POST', `/api/instructor/exams/${exam.id}/enable`)).status === 200, 'Test enabled');

  console.log('\n--- Taking the test ---');
  const s = createHttpClient(base);
  const started = await startStudent(s, 'Ada Written', exam.id);
  report(started.status === 200 && started.body.attemptStatus === 'in_progress', 'Student starts the test');
  const view = await s.call<StudentExam>('GET', '/api/exam');
  const raw = JSON.stringify(view.body);
  report(view.body.examType === 'written' && view.body.questions.find((x) => x.id === qm.id)?.answerFormat?.type === 'multiple_choice', 'Student gets the test and the choices');
  report(!raw.includes('correctIndex') && !raw.includes('accepted') && !raw.includes(SECRET_ANSWER) && !raw.includes('Never shown'), 'Correct answers are not sent to the student', raw);

  const term = openTerminal(base, { Origin: ORIGIN, Cookie: s.cookie });
  const termCode = await Promise.race([term.closed, new Promise<number>((r) => setTimeout(() => r(-1), 5000))]);
  report(termCode === TERMINAL_CLOSE.NO_SESSION, `No Linux environment exists for a written test (${termCode})`);

  const save = (id: string, answer: unknown) => s.call<QuestionProgress & { error?: { code: string } }>('PUT', `/api/exam/questions/${id}/answer`, { answer });
  report((await save(qm.id, '99')).status === 400, 'A choice that does not exist is refused');
  report((await save(qm.id, 'abc')).status === 400, 'Nonsense is refused for multiple choice');
  report((await save(qb.id, 'x'.repeat(600))).status === 400, 'A very long answer is refused');
  report((await save('no-such-question', 'x')).status === 404, 'Unknown question: 404');
  const first = await save(qm.id, '0');
  report(first.status === 200 && first.body.attempts === 1 && first.body.best === null, 'Answer saved, no right/wrong shown', JSON.stringify(first.body));
  report((await save(qm.id, '1')).status === 200, 'Answer can be changed');
  report((await save(qb.id, '   the   PACIFIC ')).status === 200, 'Fill in the blank saved');
  report((await save(qx.id, '0')).status === 200 && (await save(qx.id, '')).body.attempts === 0, 'An answer can be cleared');

  const during = (await s.call<AttemptView>('GET', '/api/attempt')).body;
  report(during.score === null && during.answers?.[qm.id] === '1', 'Score is hidden; saved answers come back after a refresh', JSON.stringify(during.answers));
  report((await s.call('POST', `/api/exam/questions/${qm.id}/submit`)).status === 404, 'The Linux submit button does not apply');
  const resumed = await s.call<SessionResponse>('POST', '/api/session');
  report(resumed.status === 200 && !resumed.body.environmentReset, 'Coming back works without a Linux environment');

  console.log('\n--- Locks still apply ---');
  await s.call('POST', '/api/attempt/left', { reason: 'switched tabs or minimized the browser' });
  const lockedSave = await save(qb.id, 'cheating');
  report(lockedSave.status === 409 && lockedSave.body.error?.code === 'TEST_LOCKED', 'A locked test cannot save answers');
  await teacher.call('POST', `/api/instructor/attempts/${during.id}/unlock`);
  report((await save(qb.id, '   the   PACIFIC ')).status === 200, 'After unlocking it can');

  console.log('\n--- When it ends ---');
  const early = await teacher.call('PUT', `/api/instructor/attempts/${during.id}/questions/${qb.id}/grade`, { correct: false });
  report(early.status === 409, 'Grades cannot be changed while the student is still working');
  const fin = (await s.call<ExamResultView>('POST', '/api/attempt/finish')).body;
  const part = (id: string) => fin.questions.find((q) => q.questionId === id);
  report(part(qm.id)?.passed === true && part(qb.id)?.passed === true && part(qx.id)?.attempts === 0 && fin.score.earned === 20 && fin.score.max === 30,
    'Graded: choice right, blank right (ignoring capitals and spaces), one unanswered: 20/30', JSON.stringify(fin.score));
  report((await save(qm.id, '0')).status === 409, 'Answers cannot change after the end');

  console.log('\n--- Reviewing and changing grades ---');
  const gradeUrl = (attempt: string, q: string) => `/api/instructor/attempts/${attempt}/questions/${q}/grade`;
  let detail = (await teacher.call<AttemptDetail>('GET', `/api/instructor/attempts/${during.id}`)).body;
  const dm = detail.questions.find((q) => q.questionId === qm.id);
  report(dm?.studentAnswer === '1' && dm.answerKey?.type === 'multiple_choice' && dm.override === null, "Instructor sees the student's answer and the correct one");
  report((await s.call('PUT', gradeUrl(during.id, qx.id), { correct: true })).status === 401, 'Students cannot change grades');
  const foreign = await fetch(`${base}${gradeUrl(during.id, qx.id)}`, {
    method: 'PUT',
    headers: { Origin: 'https://evil.example', Cookie: teacher.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ correct: true }),
  });
  report(foreign.status === 403, 'Another website cannot change grades');
  report((await teacher.call('PUT', gradeUrl(during.id, qx.id), { correct: 'yes' })).status === 400, 'Bad value refused');

  report((await teacher.call('PUT', gradeUrl(during.id, qx.id), { correct: true })).status === 204, 'Mark the unanswered question correct');
  report((await teacher.call('PUT', gradeUrl(during.id, qb.id), { correct: false })).status === 204, 'Mark a right answer not correct');
  detail = (await teacher.call<AttemptDetail>('GET', `/api/instructor/attempts/${during.id}`)).body;
  const dx = detail.questions.find((q) => q.questionId === qx.id);
  const db = detail.questions.find((q) => q.questionId === qb.id);
  report(dx?.passed === true && dx.override === true && dx.autoPassed === false && db?.passed === false && db.autoPassed === true,
    'Instructor page shows both changes and the automatic grades');
  report(detail.summary.score.earned === 20, 'Score: +10 and -10 = 20', JSON.stringify(detail.summary.score));
  const seen = (await s.call<ExamResultView>('GET', '/api/attempt/result')).body;
  report(seen.questions.find((q) => q.questionId === qb.id)?.passed === false && seen.score.earned === 20, "The student's results show the change");
  await teacher.call('PUT', gradeUrl(during.id, qb.id), { correct: null });
  await teacher.call('PUT', gradeUrl(during.id, qx.id), { correct: null });
  const back = (await teacher.call<AttemptSummary[]>('GET', '/api/instructor/attempts')).body.find((a) => a.id === during.id);
  report(back?.score.earned === 20 && back.examType === 'written' && back.percentage === 66.7, 'Back to automatic grades: 20/30', JSON.stringify(back?.score));

  console.log('\n--- Linux lab grades can be changed too ---');
  const l = createHttpClient(base);
  await startStudent(l, 'Bob Linux', 'linux-basics-sample');
  const lid = (await l.call<AttemptView>('GET', '/api/attempt')).body.id;
  await l.call('POST', '/api/exam/questions/q2-create-directory/submit');
  await l.call('POST', '/api/attempt/finish');
  report((await teacher.call('PUT', gradeUrl(lid, 'q2-create-directory'), { correct: true })).status === 204, 'Mark a Linux question correct');
  const ld = (await teacher.call<AttemptDetail>('GET', `/api/instructor/attempts/${lid}`)).body;
  report(ld.summary.score.earned === 10 && ld.questions.find((q) => q.questionId === 'q2-create-directory')?.override === true, 'Linux score updates', JSON.stringify(ld.summary.score));

  console.log('\n--- Deleting ---');
  report((await teacher.call('DELETE', `/api/instructor/attempts/${during.id}`)).status === 204, 'A written attempt with answers and grade changes can be deleted');
  report((await teacher.call('DELETE', `/api/instructor/attempts/${lid}`)).status === 204, 'A Linux attempt with a grade change can be deleted');
}

main()
  .catch((err: unknown) => report(false, 'unexpected error', err instanceof Error ? err.stack : String(err)))
  .finally(() => finish());
