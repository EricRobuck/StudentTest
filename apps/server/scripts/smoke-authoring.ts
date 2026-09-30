// Exam authoring verification: database exams, sandbox testing, approval
// rules, setup in student containers, and per-attempt frozen copies.
//
//   npm run smoke:authoring -- <baseUrl> <instructorPassword>

import type { ExamDetail, ExamSummary, InstructorQuestion, QuestionContent, StartOptionsResponse, StudentExam } from '@linuxlab/shared';
import { createHttpClient, createReporter, openTerminal, ORIGIN, startStudent } from './lib/testClient.js';

const base = process.argv[2] ?? 'http://127.0.0.1:3001';
const password = process.argv[3] ?? '';
const { report, finish } = createReporter();

const q = (over: Partial<QuestionContent>): QuestionContent => ({
  title: 'Test question',
  text: 'Do the thing.',
  points: 10,
  category: 'Test',
  difficulty: 'beginner',
  setup: [],
  validation: { mode: 'all', rules: [{ type: 'directory_exists', path: '/tmp/nothing-here' }] },
  solution: ['true'],
  ...over,
});

async function main(): Promise<void> {
  const teacher = createHttpClient(base);
  const login = await teacher.call('POST', '/api/instructor/login', { password });
  if (login.status !== 204) {
    // e.g. 429 right after smoke:instructor, which deliberately triggers the login lockout
    report(false, `Instructor sign-in failed (${login.status}); run this against a fresh backend`);
    finish();
  }

  const student0 = createHttpClient(base);
  report((await student0.call('GET', '/api/instructor/exams')).status === 401, 'Students cannot use the exam editor API');

  const exams = (await teacher.call<ExamSummary[]>('GET', '/api/instructor/exams')).body;
  const sample = exams.find((e) => e.id === 'linux-basics-sample');
  report(sample?.enabled === true && sample.open && sample.approvedCount === 5, 'Sample exam is in the database, enabled, 5 approved questions');

  const created = await teacher.call<ExamDetail>('POST', '/api/instructor/exams', { title: 'Authoring test exam' });
  const examId = created.body.id;
  report(created.status === 201 && created.body.questions.length === 0, 'New exam created');

  const bad = await teacher.call('POST', `/api/instructor/exams/${examId}/questions`, q({
    setup: [{ type: 'create_file', path: '/etc/passwd', content: 'x' }],
  }));
  report(bad.status === 400, 'Setup outside the allowed folders is refused (400)');

  const add = async (content: QuestionContent) =>
    (await teacher.call<InstructorQuestion>('POST', `/api/instructor/exams/${examId}/questions`, content)).body;

  const findQ = await add(q({
    title: 'Find the secret',
    text: 'A file named `secret.txt` is hidden somewhere under `/home/student`. Copy it to `/tmp/found.txt`.',
    setup: [{ type: 'create_file', path: '/home/student/Documents/project/archive/secret.txt', content: 'FLAG-8841\n', mode: '640' }],
    validation: { mode: 'all', rules: [{ type: 'file_contains', path: '/tmp/found.txt', text: 'FLAG-8841' }] },
    solution: ['find /home/student -name secret.txt', 'cp /home/student/Documents/project/archive/secret.txt /tmp/found.txt'],
  }));
  const cdQ = await add(q({
    title: 'Go to /var/tmp',
    validation: { mode: 'all', rules: [{ type: 'current_directory', path: '/var/tmp' }] },
    solution: ['cd /var/tmp'],
  }));
  const brokenQ = await add(q({ title: 'Broken model answer', solution: ['echo oops'] }));
  const freeQ = await add(q({
    title: 'Free points',
    validation: { mode: 'all', rules: [{ type: 'directory_exists', path: '/tmp' }] },
    solution: ['ls /tmp'],
  }));
  report([findQ, cdQ, brokenQ, freeQ].every((x) => x.status === 'draft'), 'New questions start as drafts');

  // Wait for the background sandbox tests.
  let detail: ExamDetail | undefined;
  for (let i = 0; i < 120; i++) {
    detail = (await teacher.call<ExamDetail>('GET', `/api/instructor/exams/${examId}`)).body;
    if (detail.questions.every((x) => x.verification.status !== 'running' && x.verification.status !== 'untested')) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const v = (id: string) => detail?.questions.find((x) => x.id === id)?.verification;
  report(v(findQ.id)?.status === 'passed', 'Sandbox test: "find the secret" (with setup) passes', JSON.stringify(v(findQ.id)));
  report(v(cdQ.id)?.status === 'passed', 'Sandbox test: `cd` question passes (real terminal)', JSON.stringify(v(cdQ.id)));
  report(v(brokenQ.id)?.status === 'failed' && v(brokenQ.id)?.passedAfterSolution === false,
    'Sandbox test: a model answer that does not work is caught');
  report(v(freeQ.id)?.status === 'failed' && v(freeQ.id)?.passedBeforeSolution === true,
    'Sandbox test: a question that gives free points is caught');

  const approveBroken = await teacher.call('POST', `/api/instructor/exams/${examId}/questions/${brokenQ.id}/approve`);
  report(approveBroken.status === 409, 'A question that failed its test cannot be approved (409)');
  const enableEmpty = await teacher.call('POST', `/api/instructor/exams/${examId}/enable`);
  report(enableEmpty.status === 409, 'A test without approved questions cannot be enabled (409)');
  const options0 = (await createHttpClient(base).call<StartOptionsResponse>('GET', '/api/start-options')).body;
  report(!options0.exams.some((e) => e.id === examId), 'A new (disabled) test is not offered to students');

  for (const id of [findQ.id, cdQ.id]) await teacher.call('POST', `/api/instructor/exams/${examId}/questions/${id}/approve`);
  const enabled = await teacher.call<ExamDetail>('POST', `/api/instructor/exams/${examId}/enable`);
  report(enabled.status === 200 && enabled.body.open && enabled.body.approvedCount === 2, 'Test enabled with 2 approved questions');
  const options = (await createHttpClient(base).call<StartOptionsResponse>('GET', '/api/start-options')).body;
  report(options.exams.some((e) => e.id === examId) && options.exams.some((e) => e.id === 'linux-basics-sample'),
    'Students can now choose between both open tests', JSON.stringify(options.exams.map((e) => e.title)));

  // A student now takes the new exam.
  const student = createHttpClient(base);
  await startStudent(student, 'Author Tester', examId);
  const exam = (await student.call<StudentExam>('GET', '/api/exam')).body;
  report(exam.id === examId && exam.questions.length === 2 && exam.questions[0]?.title === 'Find the secret',
    'Student gets only the approved questions, in order');
  report(!JSON.stringify(exam).includes('FLAG-8841') && !JSON.stringify(exam).includes('solution'),
    'No setup content or model answers reach the student');

  const term = openTerminal(base, { Origin: ORIGIN, Cookie: student.cookie });
  await term.opened;
  await term.waitFor(/student@linux:~\$ $/m);
  term.type('stat -c "%U %a" /home/student/Documents/project/archive/secret.txt; echo DONE$((1+1))\r');
  report(await term.waitFor(/\nstudent 640\n/), "Setup ran in the student's container (file present, owned by student, mode 640)");
  term.ws.close();

  // Editing the question now must not change the exam this student is taking.
  const edited = await teacher.call<InstructorQuestion>('PUT', `/api/instructor/exams/${examId}/questions/${findQ.id}`, {
    ...findQ.content,
    title: 'Find the secret (edited)',
  });
  report(edited.body.status === 'draft', 'Editing an approved question sends it back to draft');
  const again = (await student.call<StudentExam>('GET', '/api/exam')).body;
  report(again.questions[0]?.title === 'Find the secret', 'An exam in progress keeps its frozen copy after edits');

  await sudoExam(teacher);
  await concurrentChanges(teacher);

  // Disabling hides the test from the start screen but lets the student finish.
  await teacher.call('POST', `/api/instructor/exams/${examId}/disable`);
  const afterDisable = (await createHttpClient(base).call<StartOptionsResponse>('GET', '/api/start-options')).body;
  report(!afterDisable.exams.some((e) => e.id === examId), 'A disabled test disappears from the start screen');
  report((await student.call('GET', '/api/exam')).status === 200, 'A student already taking a disabled test can continue');
  const lateStart = await createHttpClient(base).call('POST', '/api/session/start', { name: 'Late Student', className: 'CS120-TEST', examId });
  report(lateStart.status === 409, 'Starting a disabled test is refused (409)');
  finish();
}

/** Many changes at once (like AI drafts arriving while tests finish) must not duplicate or lose anything. */
async function concurrentChanges(teacher: ReturnType<typeof createHttpClient>): Promise<void> {
  console.log('\n--- Concurrent changes ---');
  const exam = (await teacher.call<ExamDetail>('POST', '/api/instructor/exams', { title: 'Concurrency' })).body;
  const first = (await teacher.call<InstructorQuestion>('POST', `/api/instructor/exams/${exam.id}/questions`, q({
    title: 'Seed', validation: { mode: 'all', rules: [{ type: 'directory_exists', path: '/tmp/seed' }] }, solution: ['mkdir /tmp/seed'],
  }))).body;
  for (let i = 0; i < 60; i++) {
    const d = (await teacher.call<ExamDetail>('GET', `/api/instructor/exams/${exam.id}`)).body;
    if (d.questions[0]?.verification.status === 'passed') break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  await teacher.call('POST', `/api/instructor/exams/${exam.id}/questions/${first.id}/approve`);

  // Fire adds, an enable, and a settings save all at the same time.
  await Promise.all([
    ...Array.from({ length: 8 }, (_, i) =>
      teacher.call('POST', `/api/instructor/exams/${exam.id}/questions`, q({ title: `Parallel ${i}` })),
    ),
    teacher.call('POST', `/api/instructor/exams/${exam.id}/enable`),
    teacher.call('PUT', `/api/instructor/exams/${exam.id}`, { title: 'Concurrency', description: '', settings: exam.settings }),
  ]);
  const d = (await teacher.call<ExamDetail>('GET', `/api/instructor/exams/${exam.id}`)).body;
  const ids = d.questions.map((x) => x.id);
  report(ids.length === 9 && new Set(ids).size === 9, `No duplicated or lost questions (${ids.length} listed, ${new Set(ids).size} unique)`);
  report(d.enabled && d.open, 'Enable is not undone by a simultaneous settings save');
  await teacher.call('POST', `/api/instructor/exams/${exam.id}/disable`);
}

/** Admin exercises: an exam with "Students can use sudo". */
async function sudoExam(teacher: ReturnType<typeof createHttpClient>): Promise<void> {
  console.log('\n--- Exam with sudo ---');
  const exam = (await teacher.call<ExamDetail>('POST', '/api/instructor/exams', { title: 'Admin exercises' })).body;
  const settings = { ...exam.settings, allowSudo: true };
  await teacher.call('PUT', `/api/instructor/exams/${exam.id}`, { title: exam.title, description: '', settings });

  const question = (await teacher.call<InstructorQuestion>('POST', `/api/instructor/exams/${exam.id}/questions`, q({
    title: 'Create a user',
    text: 'Create a user named `alice` with a home directory.',
    validation: { mode: 'all', rules: [{ type: 'directory_exists', path: '/home/alice' }] },
    solution: ['sudo useradd -m alice'],
  }))).body;

  const waitForTest = async () => {
    for (let i = 0; i < 90; i++) {
      const d = (await teacher.call<ExamDetail>('GET', `/api/instructor/exams/${exam.id}`)).body;
      const found = d.questions.find((x) => x.id === question.id);
      if (found && found.verification.status !== 'running' && found.verification.status !== 'untested') return found;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return undefined;
  };

  let tested = await waitForTest();
  report(tested?.verification.status === 'passed', 'A question needing sudo passes its sandbox test in a sudo exam', JSON.stringify(tested?.verification));
  await teacher.call('POST', `/api/instructor/exams/${exam.id}/questions/${question.id}/approve`);
  await teacher.call('POST', `/api/instructor/exams/${exam.id}/enable`);

  const student = createHttpClient(base);
  await startStudent(student, 'Admin Student', exam.id);
  const term = openTerminal(base, { Origin: ORIGIN, Cookie: student.cookie });
  await term.opened;
  await term.waitFor(/student@linux:~\$ $/m);
  term.type('sudo -n whoami; echo DONE$((2+3))\r');
  report(await term.waitFor(/\nroot\nDONE5\n/), 'A student in a sudo exam can use sudo in their terminal');
  term.ws.close();

  // Turning sudo off: the question is re-tested without sudo, fails, and is un-approved.
  await teacher.call('PUT', `/api/instructor/exams/${exam.id}`, { title: exam.title, description: '', settings: { ...settings, allowSudo: false } });
  await new Promise((r) => setTimeout(r, 1500));
  tested = await waitForTest();
  report(tested?.verification.status === 'failed' && tested.status === 'draft',
    'Turning sudo off re-tests the exam and un-approves questions that now fail', JSON.stringify({ status: tested?.status, v: tested?.verification.status }));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
