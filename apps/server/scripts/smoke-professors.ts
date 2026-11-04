// Professor accounts: everyone signs in separately and reaches only their own
// tests and students. Uses written tests, so Docker is not needed.
//
//   npm run smoke:professors -- <baseUrl> <instructorPassword>

import type {
  AttemptDetail,
  AttemptSummary,
  AttemptView,
  ExamDetail,
  ExamSummary,
  InstructorAccountSummary,
  InstructorQuestion,
  InstructorStatus,
  QuestionContent,
  StartOptionsResponse,
} from '@linuxlab/shared';
import { createHttpClient, createReporter, startStudent } from './lib/testClient.js';

const base = process.argv[2] ?? 'http://127.0.0.1:3001';
const password = process.argv[3] ?? '';
const { report, finish } = createReporter();

const question: QuestionContent = {
  title: 'Pick B',
  text: 'Which letter is B?',
  points: 10,
  category: 'Check',
  difficulty: 'beginner',
  setup: [],
  validation: { mode: 'all', rules: [] },
  solution: [],
  answer: { type: 'multiple_choice', choices: ['A', 'B'], correctIndex: 1 },
};

const signIn = async (username: string, pw: string) => {
  const http = createHttpClient(base);
  const r = await http.call('POST', '/api/instructor/login', { username, password: pw });
  return { http, status: r.status };
};

async function main(): Promise<void> {
  console.log('--- Sign-in ---');
  const { http: admin, status } = await signIn('ADMIN', password);
  report(status === 204, 'Administrator signs in with username and password (capitals in the username ignored)');
  const adminMe = (await admin.call<InstructorStatus>('GET', '/api/instructor/me')).body.me;
  report(adminMe?.isAdmin === true && adminMe.username === 'admin', 'Server knows who is signed in', JSON.stringify(adminMe));
  report((await signIn('admin', 'wrong-password-here')).status === 401, 'Wrong password refused');
  report((await signIn('nobody-here', password)).status === 401, 'Unknown username refused the same way');

  console.log('\n--- Adding professors ---');
  const anonymous = createHttpClient(base);
  report((await anonymous.call('GET', '/api/instructor/accounts')).status === 401, 'Accounts list needs sign-in');
  const add = (body: unknown) => admin.call<InstructorAccountSummary>('POST', '/api/instructor/accounts', body);
  report((await add({ name: 'Short', username: 'short', password: 'tooshort' })).status === 400, 'A short password is refused');
  report((await add({ name: 'Bad', username: 'has spaces', password: 'long-enough-pass' })).status === 400, 'A bad username is refused');
  const a = await add({ name: 'Dr. Ada', username: 'ada', password: 'ada-password-1' });
  const b = await add({ name: 'Dr. Bob', username: 'bob', password: 'bob-password-1' });
  report(a.status === 201 && b.status === 201 && !JSON.stringify(a.body).includes('password'), 'Two professors added; no password data comes back');
  report((await add({ name: 'Dup', username: 'ADA', password: 'long-enough-pass' })).status === 409, 'A username can only be used once');

  const { http: ada, status: as } = await signIn('ada', 'ada-password-1');
  const { http: bob, status: bs } = await signIn('bob', 'bob-password-1');
  report(as === 204 && bs === 204, 'Both professors sign in');
  report((await ada.call('GET', '/api/instructor/accounts')).status === 403, 'A professor cannot list accounts');
  report((await ada.call('POST', '/api/instructor/accounts', { name: 'X', username: 'xxx', password: 'long-enough-pass' })).status === 403, 'A professor cannot add accounts');
  report((await ada.call('POST', `/api/instructor/accounts/${b.body.id}/password`, { password: 'hacked-password' })).status === 403, "A professor cannot reset someone's password");
  report((await ada.call('POST', `/api/instructor/accounts/${b.body.id}/active`, { active: false })).status === 403, 'A professor cannot disable an account');
  report((await ada.call('POST', '/api/instructor/login', { username: 'ada', password: 'ada-password-1' })).status === 204, 'Signing in again works');

  console.log('\n--- Separate tests ---');
  const list = (c: typeof admin) => c.call<ExamSummary[]>('GET', '/api/instructor/exams');
  report((await list(ada)).body.length === 0, "A new professor starts with no tests (doesn't see anyone else's)");
  const before = (await list(admin)).body.length;
  const exam = (await ada.call<ExamDetail>('POST', '/api/instructor/exams', { title: "Ada's quiz", examType: 'written' })).body;
  const bobExam = (await bob.call<ExamDetail>('POST', '/api/instructor/exams', { title: "Bob's quiz", examType: 'written' })).body;
  const q = (await ada.call<InstructorQuestion>('POST', `/api/instructor/exams/${exam.id}/questions`, question)).body;
  await ada.call('POST', `/api/instructor/exams/${exam.id}/questions/${q.id}/approve`);
  const bq = (await bob.call<InstructorQuestion>('POST', `/api/instructor/exams/${bobExam.id}/questions`, question)).body;
  await bob.call('POST', `/api/instructor/exams/${bobExam.id}/questions/${bq.id}/approve`);
  report((await ada.call('POST', `/api/instructor/exams/${exam.id}/enable`)).status === 200, 'Professor enables their test');
  await bob.call('POST', `/api/instructor/exams/${bobExam.id}/enable`);
  report((await list(ada)).body.map((e) => e.id).join() === exam.id, 'Ada sees only her test');
  report((await list(bob)).body.map((e) => e.id).join() === bobExam.id, 'Bob sees only his test');
  report((await list(admin)).body.length === before, "The administrator's list is unchanged too");

  const eu = `/api/instructor/exams/${exam.id}`;
  const attacks: Array<[string, string, string, unknown?]> = [
    ['view', 'GET', eu],
    ['rename', 'PUT', eu, { title: 'Hacked', description: '', settings: exam.settings }],
    ['delete', 'DELETE', eu],
    ['disable', 'POST', `${eu}/disable`],
    ['enable', 'POST', `${eu}/enable`],
    ['reorder', 'PUT', `${eu}/order`, { order: [q.id] }],
    ['add a question to', 'POST', `${eu}/questions`, question],
    ['edit a question of', 'PUT', `${eu}/questions/${q.id}`, question],
    ['delete a question of', 'DELETE', `${eu}/questions/${q.id}`],
    ['approve a question of', 'POST', `${eu}/questions/${q.id}/approve`],
    ['un-approve a question of', 'POST', `${eu}/questions/${q.id}/unapprove`],
    ['re-test a question of', 'POST', `${eu}/questions/${q.id}/test`],
    ['have AI write questions for', 'POST', `${eu}/generate`, { topic: 'x', count: 1, difficulty: 'beginner', pointsEach: 1 }],
  ];
  for (const [what, method, path, body] of attacks) {
    const bobTry = (await bob.call(method, path, body)).status;
    const adminTry = (await admin.call(method, path, body)).status;
    report(bobTry === 404 && adminTry === 404, `Other professors cannot ${what} a test (${bobTry}, ${adminTry})`);
  }
  // A question of Ada's reached through Bob's own test.
  report((await bob.call('POST', `/api/instructor/exams/${bobExam.id}/questions/${q.id}/unapprove`)).status === 404, "Bob cannot reach Ada's question through his own test");
  report((await ada.call<ExamDetail>('GET', eu)).body.approvedCount === 1, "After all that, Ada's test is untouched");

  console.log('\n--- Students ---');
  const opts = (await anonymous.call<StartOptionsResponse>('GET', '/api/start-options')).body;
  const shown = opts.exams.find((e) => e.id === exam.id);
  report(shown?.professor === 'Dr. Ada' && opts.exams.find((e) => e.id === bobExam.id)?.professor === 'Dr. Bob', 'Start screen shows each test with its professor', JSON.stringify(shown));
  report(!JSON.stringify(opts).includes('ownerId') && !JSON.stringify(opts).includes('ada-password'), 'Start screen reveals nothing else about accounts');

  const student = createHttpClient(base);
  report((await startStudent(student, 'Sam Student', exam.id)).status === 200, "A student takes Ada's test");
  report((await student.call('GET', '/api/instructor/exams')).status === 401, 'A student cannot use instructor pages');
  const attemptId = (await student.call<AttemptView>('GET', '/api/attempt')).body.id;
  const au = `/api/instructor/attempts/${attemptId}`;
  await student.call('PUT', `/api/exam/questions/${q.id}/answer`, { answer: '1' });
  await student.call('POST', '/api/attempt/left', { reason: 'switched tabs or minimized the browser' });

  const attempts = (c: typeof admin) => c.call<AttemptSummary[]>('GET', '/api/instructor/attempts');
  report((await attempts(ada)).body.some((x) => x.id === attemptId), 'Ada sees her student');
  report(!(await attempts(bob)).body.some((x) => x.id === attemptId), 'Bob does not');
  report(!(await attempts(admin)).body.some((x) => x.id === attemptId), 'The administrator does not');
  for (const [what, method, path, body] of [
    ['open', 'GET', au],
    ['unlock', 'POST', `${au}/unlock`],
    ['change a grade on', 'PUT', `${au}/questions/${q.id}/grade`, { correct: false }],
    ['delete', 'DELETE', au],
  ] as Array<[string, string, string, unknown?]>) {
    const bobTry = (await bob.call(method, path, body)).status;
    const adminTry = (await admin.call(method, path, body)).status;
    report(bobTry === 404 && adminTry === 404, `Other professors cannot ${what} her student's attempt (${bobTry}, ${adminTry})`);
  }
  report((await ada.call(`POST`, `${au}/unlock`)).status === 204, 'Ada can unlock her student');
  await student.call('POST', '/api/attempt/finish');
  report((await ada.call('PUT', `${au}/questions/${q.id}/grade`, { correct: false })).status === 204, 'Ada can change the grade');
  report((await ada.call<AttemptDetail>('GET', au)).body.summary.score.earned === 0, 'Score updates');
  await ada.call('PUT', `${au}/questions/${q.id}/grade`, { correct: null });

  console.log('\n--- My account ---');
  const update = await ada.call('PUT', '/api/instructor/account', { name: 'Dr. Ada Lovelace', username: 'alovelace' });
  report(update.status === 200, 'A professor changes their name and username');
  report((await ada.call('PUT', '/api/instructor/account', { name: 'Dr. Ada', username: 'bob' })).status === 409, "Can't take someone else's username");
  report((await anonymous.call<StartOptionsResponse>('GET', '/api/start-options')).body.exams.find((e) => e.id === exam.id)?.professor === 'Dr. Ada Lovelace', 'Students see the new name');
  report((await ada.call('POST', '/api/instructor/account/password', { current: 'wrong-current', next: 'ada-new-password' })).status === 400, 'Changing a password needs the current one');
  const second = await signIn('alovelace', 'ada-password-1');
  report(second.status === 204, 'Signs in with the new username');
  report((await ada.call('POST', '/api/instructor/account/password', { current: 'ada-password-1', next: 'ada-new-password' })).status === 204, 'Password changed');
  report((await ada.call('GET', '/api/instructor/exams')).status === 200, 'This window stays signed in');
  report((await second.http.call('GET', '/api/instructor/exams')).status === 401, 'Other windows are signed out');
  report((await signIn('alovelace', 'ada-password-1')).status === 401, 'The old password no longer works');
  report((await signIn('alovelace', 'ada-new-password')).status === 204, 'The new one does');

  console.log('\n--- Administrator actions ---');
  report((await admin.call('POST', `/api/instructor/accounts/${b.body.id}/password`, { password: 'short' })).status === 400, 'A reset also needs a good password');
  report((await admin.call('POST', `/api/instructor/accounts/${b.body.id}/password`, { password: 'bob-reset-password' })).status === 204, 'Administrator resets a password');
  report((await bob.call('GET', '/api/instructor/exams')).status === 401, 'That professor is signed out');
  const bob2 = await signIn('bob', 'bob-reset-password');
  report(bob2.status === 204, 'And signs in with the new password');
  report((await admin.call('POST', `/api/instructor/accounts/${adminMe!.id}/active`, { active: false })).status === 409, "The administrator can't disable their own account");
  report((await admin.call('POST', `/api/instructor/accounts/${b.body.id}/active`, { active: false })).status === 204, 'Administrator disables an account');
  report((await bob2.http.call('GET', '/api/instructor/exams')).status === 401, 'That professor is signed out immediately');
  report((await signIn('bob', 'bob-reset-password')).status === 401, 'And cannot sign in');
  const afterDisable = (await anonymous.call<StartOptionsResponse>('GET', '/api/start-options')).body;
  report(!afterDisable.exams.some((e) => e.id === bobExam.id), 'Their test closes to new students');
  report((await admin.call('POST', `/api/instructor/accounts/${b.body.id}/active`, { active: true })).status === 204, 'The account can be enabled again');
  const bob3 = await signIn('bob', 'bob-reset-password');
  report(bob3.status === 204 && (await list(bob3.http)).body.some((e) => e.id === bobExam.id), 'And their test is still theirs');

  console.log('\n--- Other websites ---');
  const foreign = await fetch(`${base}/api/instructor/accounts`, {
    method: 'POST',
    headers: { Origin: 'https://evil.example', Cookie: admin.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Evil', username: 'evil', password: 'long-enough-pass' }),
  });
  report(foreign.status === 403, 'Another website cannot add a professor using your sign-in');

  console.log('\n--- Too many wrong passwords ---');
  const statuses: number[] = [];
  for (let i = 0; i < 6; i++) statuses.push((await signIn('alovelace', `wrong-${i}-password`)).status);
  report(statuses.slice(0, 5).every((s) => s === 401) && statuses[5] === 429, 'That account is locked for this address after 5 failures', statuses.join());
  report((await signIn('admin', password)).status === 204, "Someone else on the same network can still sign in");
}

main()
  .catch((err: unknown) => report(false, 'unexpected error', err instanceof Error ? err.stack : String(err)))
  .finally(() => finish());
