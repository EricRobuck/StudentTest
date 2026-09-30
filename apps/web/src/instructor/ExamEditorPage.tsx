import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AUTHORING_LIMITS } from '@linuxlab/shared';
import type {
  AiStatus,
  Difficulty,
  ExamDetail,
  ExamSettings,
  GenerateQuestionsResponse,
  InstructorQuestion,
  SetupStep,
  ValidatorSpec,
} from '@linuxlab/shared';
import { instructorApi } from '../api/client';
import { TaskText } from '../components/TaskText';
import { OpenBadge } from './ExamsPage';
import { printable } from './format';
import { EMPTY_QUESTION, QuestionForm } from './QuestionForm';

export function ExamEditorPage({ examId, onBack }: { examId: string; onBack: () => void }) {
  const [exam, setExam] = useState<ExamDetail | null>(null);
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | 'new' | null>(null);

  const load = useCallback(async () => {
    try {
      setExam(await instructorApi.exam(examId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [examId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Ask whether AI is set up. A failed request (e.g. the server restarting)
  // is retried rather than shown as "not set up".
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = (delayMs: number) => {
      timer = setTimeout(() => {
        instructorApi
          .aiStatus()
          .then((status) => {
            if (!cancelled) setAi(status);
          })
          .catch(() => {
            if (!cancelled) check(Math.min(delayMs * 2 || 1000, 10_000));
          });
      }, delayMs);
    };
    check(0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  // While sandbox tests run in the background, refresh every few seconds.
  const testing = exam?.questions.some((q) => q.verification.status === 'running') ?? false;
  useEffect(() => {
    if (!testing) return;
    const t = setInterval(() => void load(), 2500);
    return () => clearInterval(t);
  }, [testing, load]);

  /** Runs an action, then reloads; errors are shown at the top. */
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    await load();
  };

  if (!exam) return error ? <p className="error-text">{error}</p> : <p className="muted">Loading exam…</p>;

  const move = (index: number, delta: number) => {
    const ids = exam.questions.map((q) => q.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(index + delta, 0, moved!);
    void act(() => instructorApi.reorder(exam.id, ids));
  };

  return (
    <article className="exam-editor">
      <button type="button" className="link-button" onClick={onBack}>
        ← All exams
      </button>

      <section className="panel">
        <div className="section-head">
          <h2>{exam.title}</h2>
          <span className="action-row">
            <OpenBadge exam={exam} />
            {exam.enabled ? (
              <button type="button" className="secondary" onClick={() => void act(() => instructorApi.setExamEnabled(exam.id, false))}>
                Disable (hide from students)
              </button>
            ) : (
              <>
                <button
                  type="button"
                  disabled={exam.approvedCount === 0}
                  title={exam.approvedCount === 0 ? 'Approve at least one question first' : undefined}
                  onClick={() => void act(() => instructorApi.setExamEnabled(exam.id, true))}
                >
                  Enable (students can choose it)
                </button>
                <button
                  type="button"
                  className="danger"
                  onClick={() => {
                    if (window.confirm(`Delete "${exam.title}" and all its questions?`)) {
                      void instructorApi.deleteExam(exam.id).then(onBack, (err: unknown) => setError(String(err)));
                    }
                  }}
                >
                  Delete test
                </button>
              </>
            )}
          </span>
        </div>
        <p className="muted">
          {exam.approvedCount} approved question(s) · {exam.draftCount} draft(s) · {exam.totalPoints} points · students only
          ever see approved questions. Changes (and disabling) don't affect students already taking this test.
        </p>
        {error && <p className="result result-error">{error}</p>}
        <SettingsEditor exam={exam} onSave={(body) => act(() => instructorApi.updateExam(exam.id, body))} />
      </section>

      <GeneratePanel examId={exam.id} ai={ai} onDone={load} />

      <section>
        <div className="section-head">
          <h3>Questions</h3>
          {editing !== 'new' && (
            <button type="button" className="secondary" onClick={() => setEditing('new')}>
              + Write a question myself
            </button>
          )}
        </div>
        {editing === 'new' && (
          <div className="panel">
            <QuestionForm
              initial={EMPTY_QUESTION}
              submitLabel="Add question"
              onCancel={() => setEditing(null)}
              onSubmit={async (content) => {
                await instructorApi.addQuestion(exam.id, content);
                setEditing(null);
                await load();
              }}
            />
          </div>
        )}
        {exam.questions.length === 0 && editing !== 'new' && <p className="muted">No questions yet. Write one, or let AI draft some above.</p>}
        {exam.questions.map((q, i) =>
          editing === q.id ? (
            <div key={q.id} className="panel">
              <QuestionForm
                initial={q.content}
                submitLabel="Save changes (the question goes back to draft and is re-tested)"
                onCancel={() => setEditing(null)}
                onSubmit={async (content) => {
                  await instructorApi.updateQuestion(exam.id, q.id, content);
                  setEditing(null);
                  await load();
                }}
              />
            </div>
          ) : (
            <QuestionCard
              key={q.id}
              question={q}
              number={i + 1}
              isFirst={i === 0}
              isLast={i === exam.questions.length - 1}
              onMove={(d) => move(i, d)}
              onEdit={() => setEditing(q.id)}
              onApprove={() => void act(() => instructorApi.approve(exam.id, q.id))}
              onUnapprove={() => void act(() => instructorApi.unapprove(exam.id, q.id))}
              onRetest={() => void act(() => instructorApi.retest(exam.id, q.id))}
              onDelete={() => {
                if (window.confirm(`Delete question "${q.content.title}"?`)) void act(() => instructorApi.deleteQuestion(exam.id, q.id));
              }}
            />
          ),
        )}
      </section>
    </article>
  );
}

function QuestionCard(props: {
  question: InstructorQuestion;
  number: number;
  isFirst: boolean;
  isLast: boolean;
  onMove: (delta: number) => void;
  onEdit: () => void;
  onApprove: () => void;
  onUnapprove: () => void;
  onRetest: () => void;
  onDelete: () => void;
}) {
  const { question: q, number } = props;
  const v = q.verification;
  const c = q.content;
  return (
    <div className={`panel question-card ${q.status}`}>
      <div className="section-head">
        <h4>
          {number}. {c.title} <span className="muted">· {c.points} pts · {c.difficulty}</span>
        </h4>
        <span className="action-row">
          {q.status === 'approved' ? <span className="badge badge-done">Approved</span> : <span className="badge">Draft</span>}
          {q.source === 'ai' && <span className="badge badge-live">AI</span>}
          <TestBadge status={v.status} />
        </span>
      </div>
      <p>
        <TaskText text={c.text} />
      </p>
      {c.instructions && (
        <p className="muted">
          <TaskText text={c.instructions} />
        </p>
      )}
      <details>
        <summary>How it's graded, setup, model answer{v.notes.length ? ', test notes' : ''}</summary>
        <dl className="facts small">
          <dt>Checks ({c.validation.mode === 'all' ? 'all must pass' : 'any one'})</dt>
          <dd>
            <ul className="plain">
              {c.validation.rules.map((r, i) => (
                <li key={i} className="mono">
                  {describeRule(r)}
                </li>
              ))}
            </ul>
          </dd>
          <dt>Setup</dt>
          <dd>
            {c.setup.length === 0 ? (
              <span className="muted">none</span>
            ) : (
              <ul className="plain">
                {c.setup.map((s, i) => (
                  <li key={i} className="mono">
                    {describeStep(s)}
                  </li>
                ))}
              </ul>
            )}
          </dd>
          <dt>Model answer</dt>
          <dd>
            <pre className="file-content">{c.solution.map((cmd) => `$ ${printable(cmd)}`).join('\n')}</pre>
          </dd>
          {c.hint && (
            <>
              <dt>Hint</dt>
              <dd>
                <TaskText text={c.hint} />
              </dd>
            </>
          )}
          {v.notes.length > 0 && (
            <>
              <dt>Sandbox test</dt>
              <dd>
                <ul className="plain">
                  {v.notes.map((n, i) => (
                    <li key={i}>{printable(n)}</li>
                  ))}
                </ul>
              </dd>
            </>
          )}
        </dl>
      </details>
      <div className="action-row">
        {q.status === 'draft' ? (
          <button
            type="button"
            onClick={props.onApprove}
            disabled={v.status !== 'passed'}
            title={v.status !== 'passed' ? 'Only questions that passed the sandbox test can be approved' : undefined}
          >
            Approve
          </button>
        ) : (
          <button type="button" className="secondary" onClick={props.onUnapprove}>
            Back to draft
          </button>
        )}
        <button type="button" className="secondary" onClick={props.onEdit}>
          Edit
        </button>
        <button type="button" className="secondary" onClick={props.onRetest} disabled={v.status === 'running'}>
          Test again
        </button>
        <button type="button" className="secondary" onClick={() => props.onMove(-1)} disabled={props.isFirst} aria-label="Move up">
          ↑
        </button>
        <button type="button" className="secondary" onClick={() => props.onMove(1)} disabled={props.isLast} aria-label="Move down">
          ↓
        </button>
        <button type="button" className="danger" onClick={props.onDelete}>
          Delete
        </button>
      </div>
    </div>
  );
}

function TestBadge({ status }: { status: InstructorQuestion['verification']['status'] }) {
  switch (status) {
    case 'passed':
      return <span className="badge badge-done">Test passed ✓</span>;
    case 'failed':
      return <span className="badge badge-fail">Test failed ✗</span>;
    case 'running':
      return <span className="badge badge-warn">Testing…</span>;
    default:
      return <span className="badge">Not tested</span>;
  }
}

function GeneratePanel({ examId, ai, onDone }: { examId: string; ai: AiStatus | null; onDone: () => Promise<void> }) {
  const [topic, setTopic] = useState('');
  const [notes, setNotes] = useState('');
  const [count, setCount] = useState(5);
  const [difficulty, setDifficulty] = useState<Difficulty>('beginner');
  const [pointsEach, setPointsEach] = useState(10);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<GenerateQuestionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!ai) return null;
  if (!ai.enabled) {
    return (
      <section className="panel ai-panel">
        <h3>Write questions with AI</h3>
        <p className="muted">
          Not set up yet: add your OpenAI API key to the <code>.env</code> file as <code>OPENAI_API_KEY=…</code>. The
          server picks it up automatically.
        </p>
      </section>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await instructorApi.generate(examId, { topic, count, difficulty, pointsEach, ...(notes.trim() ? { notes } : {}) }));
      await onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel ai-panel">
      <h3>Write questions with AI</h3>
      <p className="muted small">
        AI drafts the questions, the platform test-runs each one in a sandbox, and nothing reaches students until you
        approve it.
      </p>
      <form onSubmit={(e) => void submit(e)}>
        <label>
          What should the questions cover?
          <textarea
            rows={2}
            maxLength={500}
            placeholder="e.g. file permissions with chmod, including numeric modes and making a script executable"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
          />
        </label>
        <div className="form-grid">
          <label>
            How many
            <input type="number" min={1} max={AUTHORING_LIMITS.generateCountMax} value={count} onChange={(e) => setCount(Number(e.target.value))} />
          </label>
          <label>
            Difficulty
            <select value={difficulty} onChange={(e) => setDifficulty(e.target.value as Difficulty)}>
              <option value="beginner">Beginner</option>
              <option value="intermediate">Intermediate</option>
              <option value="advanced">Advanced</option>
            </select>
          </label>
          <label>
            Points each
            <input type="number" min={1} max={100} value={pointsEach} onChange={(e) => setPointsEach(Number(e.target.value))} />
          </label>
        </div>
        <label>
          Anything else? (optional)
          <input
            maxLength={1000}
            placeholder="e.g. use a folder called /home/student/webapp; include one question with grep"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>
        <button type="submit" disabled={busy || topic.trim().length === 0}>
          {busy ? 'AI is writing questions… (a few minutes for large batches)' : 'Generate draft questions'}
        </button>
      </form>
      {error && <p className="result result-error">{error}</p>}
      {result && (
        <div className="result result-recorded">
          Added {result.created.length} draft question(s). They are being tested in a sandbox now; approve the ones you
          like.
          {result.rejected.length > 0 && (
            <>
              {' '}
              {result.rejected.length} draft(s) were discarded because they didn't follow the rules:
              <ul>
                {result.rejected.map((r, i) => (
                  <li key={i}>
                    {r.title}: {r.errors.join(' ')}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function SettingsEditor({
  exam,
  onSave,
}: {
  exam: ExamDetail;
  onSave: (body: { title: string; description: string; settings: ExamSettings }) => Promise<void>;
}) {
  const [title, setTitle] = useState(exam.title);
  const [description, setDescription] = useState(exam.description ?? '');
  const [s, setS] = useState<ExamSettings>(exam.settings);
  const [saved, setSaved] = useState(false);
  const flag = (key: keyof ExamSettings) => (
    <input type="checkbox" checked={s[key] === true} onChange={(e) => setS({ ...s, [key]: e.target.checked })} />
  );
  const numberOrNull = (v: string) => (v.trim() === '' ? null : Number(v));

  return (
    <details className="settings">
      <summary>Exam settings</summary>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void onSave({ title, description, settings: s }).then(() => setSaved(true));
        }}
      >
        <div className="form-grid">
          <label>
            Title
            <input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label>
            Mode
            <select value={s.mode} onChange={(e) => setS({ ...s, mode: e.target.value === 'exam' ? 'exam' : 'practice' })}>
              <option value="practice">Practice (students may retake)</option>
              <option value="exam">Exam (one attempt)</option>
            </select>
          </label>
          <label>
            Time limit (minutes, empty = none)
            <input
              type="number"
              min={1}
              value={s.timeLimitMinutes ?? ''}
              onChange={(e) => setS({ ...s, timeLimitMinutes: numberOrNull(e.target.value) })}
            />
          </label>
          <label>
            Attempts per question (empty = unlimited)
            <input
              type="number"
              min={1}
              value={s.threeTries !== false ? 3 : (s.maxAttemptsPerQuestion ?? '')}
              disabled={s.threeTries !== false}
              title={s.threeTries !== false ? 'Set by the three-tries rule below' : undefined}
              onChange={(e) => setS({ ...s, maxAttemptsPerQuestion: numberOrNull(e.target.value) })}
            />
          </label>
        </div>
        <label>
          Description (optional)
          <input value={description} maxLength={1000} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <div className="checkbox-row">
          <label>{flag('allowHints')} Show hints</label>
          <label>{flag('showFeedback')} Show right/wrong after each submit</label>
          <label>{flag('showScoreDuringExam')} Show score during the exam</label>
          <label>{flag('lockAfterSubmit')} One submission per question</label>
        </div>
        <div className="sudo-setting">
          <label>
            <input
              type="checkbox"
              checked={s.threeTries !== false}
              onChange={(e) =>
                setS({ ...s, threeTries: e.target.checked, ...(e.target.checked ? {} : { maxAttemptsPerQuestion: null }) })
              }
            />{' '}
            Three tries per question, with fewer points for later tries
          </label>
          <p className="muted small">
            A correct answer earns 100% of the points on the first try, 90% on the second and 60% on the third. Three
            wrong answers earn 0 and close the question.
          </p>
        </div>
        <div className="sudo-setting">
          <label>
            <input
              type="checkbox"
              checked={s.lockOnLeave !== false}
              onChange={(e) => setS({ ...s, lockOnLeave: e.target.checked })}
            />{' '}
            Lock the test if the student leaves the screen
          </label>
          <p className="muted small">
            Switching tabs, minimizing the browser, switching to another window or app, or closing/refreshing the page
            locks the test. The student must call you over, and you unlock it from Student attempts.
          </p>
        </div>
        <div className="sudo-setting">
          <label>
            {flag('allowSudo')} Students can use <code>sudo</code> (admin exercises)
          </label>
          <p className="muted small">
            Lets students act as root inside their own Linux environment (e.g. read <code>/etc/shadow</code>, add users).
            Their environment is less isolated and a determined student could interfere with grading, so use it only for
            exams that teach admin skills. Changing this re-tests every question in the exam.
          </p>
        </div>
        <button type="submit">Save settings</button>
        {saved && <span className="muted"> Saved. New attempts use these settings.</span>}
      </form>
    </details>
  );
}

function describeRule(r: ValidatorSpec): string {
  switch (r.type) {
    case 'current_directory':
      return `terminal is in ${r.path}`;
    case 'directory_exists':
      return `directory ${r.path} exists`;
    case 'file_exists':
      return `file ${r.path} exists`;
    case 'file_contains':
      return `${r.path} contains "${r.text}"`;
    case 'file_permissions':
      return `${r.path} has permissions ${r.mode}`;
  }
}

function describeStep(s: SetupStep): string {
  return s.type === 'create_directory'
    ? `folder ${s.path}`
    : `file ${s.path}${s.mode ? ` (mode ${s.mode})` : ''}: ${JSON.stringify(s.content.slice(0, 80))}${s.content.length > 80 ? '…' : ''}`;
}
