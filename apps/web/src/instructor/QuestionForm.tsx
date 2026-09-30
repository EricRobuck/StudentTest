import { useState, type FormEvent } from 'react';
import {
  SETUP_PATH_PREFIXES,
  validateQuestionContent,
  type Difficulty,
  type QuestionContent,
  type SetupStep,
  type ValidatorSpec,
  type ValidatorType,
} from '@linuxlab/shared';

// Form for one question: no JSON, just fields. The same validation as the
// server runs before saving, so mistakes show up immediately.

export const EMPTY_QUESTION: QuestionContent = {
  title: '',
  text: '',
  points: 10,
  category: 'Linux Basics',
  difficulty: 'beginner',
  setup: [],
  validation: { mode: 'all', rules: [{ type: 'directory_exists', path: '' }] },
  solution: [],
};

const CHECK_LABELS: Record<ValidatorType, string> = {
  current_directory: 'Terminal is in directory',
  directory_exists: 'Directory exists',
  file_exists: 'File exists',
  file_contains: 'File contains text',
  file_permissions: 'File has permissions',
};

interface QuestionFormProps {
  initial: QuestionContent;
  submitLabel: string;
  onSubmit: (content: QuestionContent) => Promise<void>;
  onCancel: () => void;
}

export function QuestionForm({ initial, submitLabel, onSubmit, onCancel }: QuestionFormProps) {
  const [q, setQ] = useState<QuestionContent>(initial);
  const [solutionText, setSolutionText] = useState(initial.solution.join('\n'));
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const set = <K extends keyof QuestionContent>(key: K, value: QuestionContent[K]) => setQ((prev) => ({ ...prev, [key]: value }));
  const setRule = (i: number, rule: ValidatorSpec) =>
    set('validation', { ...q.validation, rules: q.validation.rules.map((r, j) => (j === i ? rule : r)) });
  const setStep = (i: number, step: SetupStep) => set('setup', q.setup.map((s, j) => (j === i ? step : s)));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const content = { ...q, solution: solutionText.split('\n').map((l) => l.trim()).filter(Boolean) };
    const checked = validateQuestionContent(content);
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    setErrors([]);
    setSaving(true);
    try {
      await onSubmit(checked.value);
    } catch (err) {
      setErrors([err instanceof Error ? err.message : String(err)]);
      setSaving(false);
    }
  };

  return (
    <form className="question-form" onSubmit={(e) => void submit(e)} noValidate>
      <div className="form-grid">
        <label>
          Title
          <input value={q.title} maxLength={120} onChange={(e) => set('title', e.target.value)} />
        </label>
        <label>
          Points
          <input type="number" min={1} max={100} value={q.points} onChange={(e) => set('points', Number(e.target.value))} />
        </label>
        <label>
          Category
          <input value={q.category} maxLength={40} onChange={(e) => set('category', e.target.value)} />
        </label>
        <label>
          Difficulty
          <select value={q.difficulty} onChange={(e) => set('difficulty', e.target.value as Difficulty)}>
            <option value="beginner">Beginner</option>
            <option value="intermediate">Intermediate</option>
            <option value="advanced">Advanced</option>
          </select>
        </label>
      </div>

      <label>
        Question (shown to students; put paths and commands in `backticks`)
        <textarea rows={3} value={q.text} onChange={(e) => set('text', e.target.value)} />
      </label>
      <label>
        Extra instructions (optional)
        <textarea rows={2} value={q.instructions ?? ''} onChange={(e) => set('instructions', e.target.value)} />
      </label>

      <fieldset>
        <legend>Setup: prepared before the exam starts (optional)</legend>
        <p className="muted small">Only inside {SETUP_PATH_PREFIXES.join(', ')}. Everything created belongs to the student.</p>
        {q.setup.map((s, i) => (
          <div key={i} className="row-editor">
            <select
              value={s.type}
              onChange={(e) =>
                setStep(i, e.target.value === 'create_file' ? { type: 'create_file', path: s.path, content: '' } : { type: 'create_directory', path: s.path })
              }
            >
              <option value="create_directory">Create folder</option>
              <option value="create_file">Create file</option>
            </select>
            <input className="mono" placeholder="/home/student/…" value={s.path} onChange={(e) => setStep(i, { ...s, path: e.target.value })} />
            {s.type === 'create_file' && (
              <>
                <input
                  className="mono narrow"
                  placeholder="mode 644"
                  value={s.mode ?? ''}
                  onChange={(e) => setStep(i, { ...s, mode: e.target.value || undefined })}
                />
                <textarea
                  className="mono full"
                  rows={3}
                  placeholder="File contents"
                  value={s.content}
                  onChange={(e) => setStep(i, { ...s, content: e.target.value })}
                />
              </>
            )}
            <button type="button" className="link-button" onClick={() => set('setup', q.setup.filter((_, j) => j !== i))}>
              Remove
            </button>
          </div>
        ))}
        <button type="button" className="secondary" onClick={() => set('setup', [...q.setup, { type: 'create_file', path: '/home/student/', content: '' }])}>
          + Add setup step
        </button>
      </fieldset>

      <fieldset>
        <legend>Checks: how the answer is graded</legend>
        <label className="inline">
          The question passes when{' '}
          <select
            value={q.validation.mode}
            onChange={(e) => set('validation', { ...q.validation, mode: e.target.value === 'any' ? 'any' : 'all' })}
          >
            <option value="all">all checks pass</option>
            <option value="any">any one check passes</option>
          </select>
        </label>
        {q.validation.rules.map((r, i) => (
          <div key={i} className="row-editor">
            <select value={r.type} onChange={(e) => setRule(i, blankRule(e.target.value as ValidatorType, r.path))}>
              {(Object.keys(CHECK_LABELS) as ValidatorType[]).map((t) => (
                <option key={t} value={t}>
                  {CHECK_LABELS[t]}
                </option>
              ))}
            </select>
            <input className="mono" placeholder="/path" value={r.path} onChange={(e) => setRule(i, { ...r, path: e.target.value })} />
            {r.type === 'file_contains' && (
              <input placeholder="exact text (case-sensitive)" value={r.text} onChange={(e) => setRule(i, { ...r, text: e.target.value })} />
            )}
            {r.type === 'file_permissions' && (
              <input className="mono narrow" placeholder="640" value={r.mode} onChange={(e) => setRule(i, { ...r, mode: e.target.value })} />
            )}
            <button
              type="button"
              className="link-button"
              onClick={() => set('validation', { ...q.validation, rules: q.validation.rules.filter((_, j) => j !== i) })}
            >
              Remove
            </button>
          </div>
        ))}
        <button
          type="button"
          className="secondary"
          onClick={() => set('validation', { ...q.validation, rules: [...q.validation.rules, { type: 'file_exists', path: '' }] })}
        >
          + Add check
        </button>
      </fieldset>

      <label>
        Model answer (instructor only): commands that complete the task, one per line. Used by the sandbox test.
        <textarea className="mono" rows={4} value={solutionText} onChange={(e) => setSolutionText(e.target.value)} />
      </label>
      <div className="form-grid">
        <label>
          Hint (optional, practice mode)
          <textarea rows={2} value={q.hint ?? ''} onChange={(e) => set('hint', e.target.value)} />
        </label>
        <label>
          Explanation (optional)
          <textarea rows={2} value={q.explanation ?? ''} onChange={(e) => set('explanation', e.target.value)} />
        </label>
      </div>

      {errors.length > 0 && (
        <ul className="result result-error">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      <div className="form-actions">
        <button type="submit" disabled={saving}>
          {saving ? 'Saving…' : submitLabel}
        </button>
        <button type="button" className="secondary" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function blankRule(type: ValidatorType, path: string): ValidatorSpec {
  switch (type) {
    case 'file_contains':
      return { type, path, text: '' };
    case 'file_permissions':
      return { type, path, mode: '' };
    default:
      return { type, path };
  }
}
