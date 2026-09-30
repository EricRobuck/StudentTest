import OpenAI from 'openai';
import {
  AUTHORING_LIMITS,
  SETUP_PATH_PREFIXES,
  validateQuestionContent,
  type GenerateQuestionsRequest,
  type QuestionContent,
} from '@linuxlab/shared';

// Drafts exam questions with an OpenAI model (Responses API, strict JSON
// schema output). Everything the model returns is treated as untrusted: it
// must match the schema, then pass the same validation as hand-written
// questions, then pass the sandbox test, and finally be approved by the
// instructor before any student sees it.

export class GenerationError extends Error {}

export interface GeneratedDrafts {
  valid: QuestionContent[];
  rejected: Array<{ title: string; errors: string[] }>;
}

/** What the student may do, which differs for exams with sudo turned on. */
function studentPowers(allowSudo: boolean): string {
  return allowSudo
    ? `- Ubuntu 24.04 in a container, Bash shell, user \`student\` with passwordless \`sudo\` (this is an admin exercise: questions may and often should require sudo, e.g. reading /etc/shadow, creating users and groups with useradd/groupadd/usermod, changing ownership with chown, editing files in /etc). Home directory /home/student (which contains Documents, Downloads, Desktop).
- Without sudo the student can only write inside /home/student, /tmp and /var/tmp; with sudo they can change system files. Model answers must use sudo where root is needed (never \`sudo -i\` or \`su\`; use \`sudo command\` for each step). Nothing can be installed (no network) and mounting, networking and kernel settings are blocked even for root.`
    : `- Ubuntu 24.04 in a container, Bash shell, user \`student\` (not root, no sudo), home directory /home/student (which contains Documents, Downloads, Desktop).
- The student can only write inside /home/student, /tmp and /var/tmp. Everything else (e.g. /etc, /opt, /srv) is read-only for them, and root-only files such as /etc/shadow cannot be read. For topics about such files, use setup to give the student a realistic practice copy in their home folder instead.`;
}

const SYSTEM_PROMPT_TEMPLATE = `You write practical Linux exam questions for college students in an introductory IT course. Each student works in a real Bash terminal inside their own isolated container, and an automatic grader checks the RESULTING STATE of the container when the student clicks Submit. It never looks at which commands they typed, so any correct method must pass.

The student's environment:
{{STUDENT_POWERS}}
- No network access. No compilers, no Python, no package installation.
- Installed tools: coreutils (ls, cp, mv, rm, mkdir, rmdir, touch, cat, head, tail, wc, sort, uniq, cut, tr, chmod, ln, stat, du, df, echo, printf, date, basename, dirname), findutils (find, xargs), grep, sed, awk, less, more, file, tree, ps, pgrep, kill, killall, nano, vi, bash.

What the grader can check (use only these):
- current_directory {path}: the student's terminal is currently in this directory when they submit. Only use this when the task is to navigate somewhere, and tell the student to stay there and submit.
- directory_exists {path}: a real directory (not a symlink) exists.
- file_exists {path}: a regular file exists.
- file_contains {path, text}: the file contains this exact, case-sensitive text. The question must state the exact text or make it unambiguous (for example, copying a line from a provided file).
- file_permissions {path, mode}: the file's permission bits equal this octal mode, such as 640.
Use checks_mode "all" when every check must pass (the usual case), or "any" when any one is enough.

Setup (optional) runs as the exam starts, before the student sees the question, and creates things for the task: create_directory {path} and create_file {path, content, mode}. Use mode "" for the default of 644. Everything created is owned by the student. Setup paths must start with one of: ${SETUP_PATH_PREFIXES.join(', ')}. Use setup for tasks like finding a hidden file, searching logs with grep, fixing permissions on a provided file, or reorganizing provided files.

Model answer ("solution"): the exact shell commands a student could type, in order, one command per list item, that fully complete the task starting from a fresh environment after setup. They run one after another in the student's interactive terminal (so cd persists between them). Each must finish on its own: never use editors (nano, vi), pagers (less, more), or anything that waits for input. They must leave the container in a state that passes every check.

Rules for good questions:
- Grade only what the task asks for. Checks must FAIL in the fresh environment, before the student does anything, and PASS after the model answer.
- Every question is independent: give each question its own unique folder or file names (for example /home/student/q3_logs/...) so questions don't interfere with each other or rely on each other.
- Write the question text as a clear instruction to the student with the exact paths and names they need. Put paths, file names, commands and exact text in \`backticks\`.
- Do not reveal the answer command in the question text. Put guidance in the hint instead, and explain the answer in the explanation (the explanation is shown after the exam).
- Match the requested difficulty: beginner means one or two basic commands; intermediate combines a few commands or options; advanced may need pipes, find with conditions, or several steps.`;

/** JSON schema for the drafts. Kept within what structured outputs support. */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['questions'],
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'text', 'instructions', 'category', 'difficulty', 'setup', 'checks_mode', 'checks', 'hint', 'explanation', 'solution'],
        properties: {
          title: { type: 'string', description: 'Short title, a few words.' },
          text: { type: 'string', description: 'The task, addressed to the student.' },
          instructions: { type: 'string', description: 'Optional extra instructions, or empty string.' },
          category: { type: 'string', description: 'Topic, e.g. Permissions, Navigation, grep, find.' },
          difficulty: { type: 'string', enum: ['beginner', 'intermediate', 'advanced'] },
          setup: {
            type: 'array',
            items: {
              anyOf: [
                {
                  type: 'object',
                  additionalProperties: false,
                  required: ['type', 'path'],
                  properties: { type: { type: 'string', enum: ['create_directory'] }, path: { type: 'string' } },
                },
                {
                  type: 'object',
                  additionalProperties: false,
                  required: ['type', 'path', 'content', 'mode'],
                  properties: {
                    type: { type: 'string', enum: ['create_file'] },
                    path: { type: 'string' },
                    content: { type: 'string' },
                    mode: { type: 'string', description: 'Octal like 644, or empty string for the default.' },
                  },
                },
              ],
            },
          },
          checks_mode: { type: 'string', enum: ['all', 'any'] },
          checks: {
            type: 'array',
            items: {
              anyOf: [
                {
                  type: 'object',
                  additionalProperties: false,
                  required: ['type', 'path'],
                  properties: {
                    type: { type: 'string', enum: ['current_directory', 'directory_exists', 'file_exists'] },
                    path: { type: 'string' },
                  },
                },
                {
                  type: 'object',
                  additionalProperties: false,
                  required: ['type', 'path', 'text'],
                  properties: { type: { type: 'string', enum: ['file_contains'] }, path: { type: 'string' }, text: { type: 'string' } },
                },
                {
                  type: 'object',
                  additionalProperties: false,
                  required: ['type', 'path', 'mode'],
                  properties: { type: { type: 'string', enum: ['file_permissions'] }, path: { type: 'string' }, mode: { type: 'string' } },
                },
              ],
            },
          },
          hint: { type: 'string' },
          explanation: { type: 'string' },
          solution: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
} as const;

interface RawDraft {
  title?: unknown;
  text?: unknown;
  instructions?: unknown;
  category?: unknown;
  difficulty?: unknown;
  setup?: Array<Record<string, unknown>>;
  checks_mode?: unknown;
  checks?: unknown;
  hint?: unknown;
  explanation?: unknown;
  solution?: unknown;
}

export class QuestionGenerator {
  private client: OpenAI | undefined;

  constructor(readonly model: string) {}

  /** The SDK reads OPENAI_API_KEY from the environment (e.g. the .env file). */
  get enabled(): boolean {
    return Boolean(process.env.OPENAI_API_KEY);
  }

  async generate(
    request: GenerateQuestionsRequest,
    existingTitles: string[],
    options: { allowSudo: boolean } = { allowSudo: false },
  ): Promise<GeneratedDrafts> {
    if (!this.enabled) throw new GenerationError('AI question writing is not set up: add OPENAI_API_KEY to the .env file.');
    // Large batches can take several minutes; allow up to 20 before giving up.
    this.client ??= new OpenAI({ timeout: 20 * 60 * 1000 });

    const avoid = existingTitles.length
      ? `\nThe exam already has these questions, so don't repeat them: ${existingTitles.map((t) => `"${t}"`).join(', ')}.`
      : '';
    const prompt =
      `Write ${request.count} ${request.difficulty} question(s) about: ${request.topic}` +
      (request.notes ? `\nInstructor's notes: ${request.notes}` : '') +
      avoid;

    let response: OpenAI.Responses.Response;
    try {
      response = await this.client.responses.create({
        model: this.model,
        instructions: SYSTEM_PROMPT_TEMPLATE.replace('{{STUDENT_POWERS}}', studentPowers(options.allowSudo)),
        input: prompt,
        reasoning: { effort: 'medium' },
        // Room for the reasoning plus up to 30 questions of JSON.
        max_output_tokens: 100000,
        // Strict mode: the answer is guaranteed to match OUTPUT_SCHEMA.
        text: { format: { type: 'json_schema', name: 'exam_questions', schema: OUTPUT_SCHEMA, strict: true } },
      });
    } catch (err) {
      // OpenAI's own message (never contains the key) helps diagnose model/quota/schema problems.
      if (err instanceof OpenAI.APIError) {
        console.warn(`[ai] OpenAI error ${err.status ?? ''} (code ${err.code ?? '-'}, type ${err.type ?? '-'}): ${err.message}`);
      }
      if (err instanceof OpenAI.AuthenticationError) throw new GenerationError('The OpenAI API key was rejected. Check OPENAI_API_KEY in .env.');
      if (err instanceof OpenAI.PermissionDeniedError) throw new GenerationError('The OpenAI API key is not allowed to use this model.');
      if (err instanceof OpenAI.NotFoundError) throw new GenerationError(`The model "${this.model}" is not available to this API key.`);
      if (err instanceof OpenAI.RateLimitError) {
        throw new GenerationError(
          err.type === 'insufficient_quota' || err.code === 'insufficient_quota' || err.code === 'credit_balance_exhausted'
            ? 'Your OpenAI account has no API credits left. Add credits at platform.openai.com → Settings → Billing.'
            : 'OpenAI rate limit reached. Try again in a minute.',
        );
      }
      if (err instanceof OpenAI.APIConnectionError) throw new GenerationError('Could not reach the OpenAI API. Check the internet connection.');
      if (err instanceof OpenAI.APIError) throw new GenerationError(`The OpenAI API returned an error (${err.status ?? 'unknown'}).`);
      throw err;
    }

    const refused = response.output.some(
      (item) => item.type === 'message' && item.content.some((c) => c.type === 'refusal'),
    );
    if (refused || response.incomplete_details?.reason === 'content_filter') {
      throw new GenerationError('The AI declined to write these questions. Try rewording the topic.');
    }
    if (response.status === 'incomplete') {
      throw new GenerationError('The answer was cut off (too long). Ask for fewer questions at a time.');
    }

    let parsed: { questions?: RawDraft[] };
    try {
      parsed = JSON.parse(response.output_text) as { questions?: RawDraft[] };
    } catch {
      throw new GenerationError('The AI returned an answer that could not be read. Please try again.');
    }

    const drafts: GeneratedDrafts = { valid: [], rejected: [] };
    for (const raw of (parsed.questions ?? []).slice(0, AUTHORING_LIMITS.generateCountMax)) {
      const checked = validateQuestionContent(toContent(raw, request.pointsEach));
      if (checked.ok) drafts.valid.push(checked.value);
      else drafts.rejected.push({ title: typeof raw.title === 'string' ? raw.title : '(untitled)', errors: checked.errors });
    }
    console.log(
      `[ai] ${response.model}: ${drafts.valid.length} draft(s), ${drafts.rejected.length} rejected, ` +
        `${response.usage?.input_tokens ?? '?'} in / ${response.usage?.output_tokens ?? '?'} out tokens`,
    );
    return drafts;
  }
}

/** Maps the AI's JSON onto QuestionContent (validated right after). */
function toContent(raw: RawDraft, points: number): unknown {
  return {
    title: raw.title,
    text: raw.text,
    instructions: raw.instructions,
    points,
    category: raw.category,
    difficulty: raw.difficulty,
    setup: (raw.setup ?? []).map((s) => (s.type === 'create_file' && s.mode === '' ? { ...s, mode: undefined } : s)),
    validation: { mode: raw.checks_mode, rules: raw.checks },
    hint: raw.hint,
    explanation: raw.explanation,
    solution: raw.solution,
  };
}
