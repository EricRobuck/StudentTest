import type { ExamDefinition, ExamSettings } from './types.js';

// The MVP's single hard-coded exam (requirements §22). Each question grades
// the resulting state of the container, never the exact command typed.

export const practiceSettings: ExamSettings = {
  mode: 'practice',
  allowHints: true,
  timeLimitMinutes: 45,
  maxAttemptsPerQuestion: null,
  showFeedback: true,
  showScoreDuringExam: true,
  lockAfterSubmit: false,
};

/** Strict settings for trying exam mode: SAMPLE_EXAM_MODE=exam. */
export const examModeSettings: ExamSettings = {
  mode: 'exam',
  allowHints: false,
  timeLimitMinutes: 30,
  maxAttemptsPerQuestion: 2,
  showFeedback: false,
  showScoreDuringExam: false,
  lockAfterSubmit: false,
};

export const sampleExam: ExamDefinition = {
  id: 'linux-basics-sample',
  title: 'Linux Practical Exam',
  description: 'Five introductory tasks: navigation, directories, files, contents, and permissions.',
  settings: practiceSettings,
  questions: [
    {
      id: 'q1-navigate-etc',
      order: 1,
      labType: 'linux',
      title: 'Navigation',
      text: 'Navigate to the `/etc` directory.',
      instructions: 'Leave your terminal in that directory, then click Submit Answer.',
      points: 10,
      category: 'Navigation',
      difficulty: 'beginner',
      setup: [],
      validation: { mode: 'all', rules: [{ type: 'current_directory', path: '/etc' }] },
      hint: 'The `cd` command changes your current directory. `pwd` shows where you are.',
      explanation: '`cd /etc` moves the shell into /etc; `pwd` confirms it.',
    },
    {
      id: 'q2-create-directory',
      order: 2,
      labType: 'linux',
      title: 'Directory Creation',
      text: 'Create a directory named `cybersecurity` inside `/tmp`.',
      points: 10,
      category: 'Filesystem',
      difficulty: 'beginner',
      setup: [],
      validation: { mode: 'all', rules: [{ type: 'directory_exists', path: '/tmp/cybersecurity' }] },
      hint: 'Use `mkdir`. You can give it a full path, or `cd` somewhere first.',
      explanation: '`mkdir /tmp/cybersecurity` (or `cd /tmp` then `mkdir cybersecurity`).',
    },
    {
      id: 'q3-create-file',
      order: 3,
      labType: 'linux',
      title: 'File Creation',
      text: 'Create a file named `test.txt` inside `/tmp/cybersecurity`.',
      points: 10,
      category: 'Filesystem',
      difficulty: 'beginner',
      setup: [],
      validation: { mode: 'all', rules: [{ type: 'file_exists', path: '/tmp/cybersecurity/test.txt' }] },
      hint: '`touch` creates an empty file.',
      explanation: '`touch /tmp/cybersecurity/test.txt`',
    },
    {
      id: 'q4-file-contents',
      order: 4,
      labType: 'linux',
      title: 'File Contents',
      text: 'Place the text `Linux is awesome` into `/tmp/cybersecurity/test.txt`.',
      points: 10,
      category: 'Bash',
      difficulty: 'beginner',
      setup: [],
      validation: {
        mode: 'all',
        rules: [{ type: 'file_contains', path: '/tmp/cybersecurity/test.txt', text: 'Linux is awesome' }],
      },
      hint: '`echo` prints text, and `>` sends output into a file instead of the screen.',
      explanation: '`echo "Linux is awesome" > /tmp/cybersecurity/test.txt` (or edit it with nano).',
    },
    {
      id: 'q5-permissions',
      order: 5,
      labType: 'linux',
      title: 'Permissions',
      text: 'Set the permissions of `/tmp/cybersecurity/test.txt` to `640`.',
      instructions: 'Owner: read and write. Group: read. Others: no access.',
      points: 10,
      category: 'Permissions',
      difficulty: 'beginner',
      setup: [],
      validation: {
        mode: 'all',
        rules: [{ type: 'file_permissions', path: '/tmp/cybersecurity/test.txt', mode: '640' }],
      },
      hint: '`chmod` changes permissions. In octal, read = 4, write = 2, execute = 1.',
      explanation: '`chmod 640 /tmp/cybersecurity/test.txt` — 6 = rw- (owner), 4 = r-- (group), 0 = --- (others).',
    },
  ],
};
