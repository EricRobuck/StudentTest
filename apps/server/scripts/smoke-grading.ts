// Phase 6 verification: grades the five sample questions against a real
// container, typing into a real terminal shell like a student would,
// including attempts to fool the grader.
//
//   npm run smoke:grading

import { randomUUID } from 'node:crypto';
import { config } from '../src/config.js';
import { createDockerRuntime } from '../src/modules/containers/index.js';
import { sampleExam } from '../src/modules/exams/sampleExam.js';
import { gradeQuestion } from '../src/modules/grading/index.js';

const runtime = createDockerRuntime(config.containers);
let failures = 0;

async function main(): Promise<void> {
  const c = await runtime.createSessionContainer(`grading-${randomUUID().slice(0, 8)}`);
  const shell = await runtime.attachShell(c.containerId, { cols: 120, rows: 30 });
  shell.onData(() => undefined); // keep the PTY output flowing
  const ctx = { runtime, containerId: c.containerId };

  /** Types a command into the student's terminal and gives it a moment to run. */
  const type = async (command: string) => {
    shell.write(Buffer.from(`${command}\n`));
    await new Promise((r) => setTimeout(r, 600));
  };

  const expectGrade = async (questionNumber: number, expectPass: boolean, scenario: string) => {
    const q = sampleExam.questions[questionNumber - 1]!;
    const grade = await gradeQuestion(ctx, q.validation);
    const ok = grade.passed === expectPass;
    if (!ok) failures++;
    const msg = grade.rules.map((r) => r.message).join(' ');
    console.log(`${ok ? 'PASS' : 'FAIL'}  Q${questionNumber} ${expectPass ? 'passes' : 'fails '} when ${scenario}`);
    console.log(`        → ${msg}`);
  };

  try {
    await new Promise((r) => setTimeout(r, 800)); // let bash start

    console.log('Fresh container, nothing done yet:');
    for (const n of [1, 2, 3, 4, 5]) await expectGrade(n, false, 'nothing has been done');

    console.log('\nAttempts to fool the grader:');
    await type('ln -s /tmp /tmp/cybersecurity');
    await expectGrade(2, false, 'cybersecurity is only a symlink');
    await type('rm /tmp/cybersecurity');
    await type('(cd /etc && sleep 30) &');
    await expectGrade(1, false, 'only a background job is in /etc');

    console.log('\nNested shell:');
    await type('bash');
    await type('cd /etc');
    await expectGrade(1, true, 'a nested bash is in /etc');
    await type('exit');
    await expectGrade(1, false, 'back in the outer shell (home)');

    console.log('\nDoing the exam properly, several ways:');
    await type('cd /');
    await type('cd etc');
    await expectGrade(1, true, 'reached with `cd /` then `cd etc`');
    await type('cd /tmp && mkdir cybersecurity');
    await expectGrade(2, true, 'created with a relative path');
    await expectGrade(1, false, 'the terminal has moved on to /tmp');
    await type('touch ~/../../tmp/cybersecurity/test.txt');
    await expectGrade(3, true, 'created via a roundabout path');
    await type('echo "linux is awesome" > cybersecurity/test.txt');
    await expectGrade(4, false, 'the text has the wrong capitalization');
    await type('printf "Notes\\nLinux is awesome\\n" > cybersecurity/test.txt');
    await expectGrade(4, true, 'the text is on the second line');
    await type('chmod 644 cybersecurity/test.txt');
    await expectGrade(5, false, 'permissions are 644');
    await type('chmod u=rw,g=r,o= cybersecurity/test.txt');
    await expectGrade(5, true, 'set with symbolic chmod (u=rw,g=r,o=)');
    await type('chmod 000 cybersecurity/test.txt');
    await expectGrade(4, true, 'the file is unreadable to the student (grader still reads it)');
  } finally {
    shell.close();
    await runtime.destroy(c.containerId);
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
