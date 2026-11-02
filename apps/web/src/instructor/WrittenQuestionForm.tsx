import { useState, type FormEvent } from 'react';
import { AUTHORING_LIMITS, validateQuestionContent, type AnswerKey, type Difficulty, type QuestionContent } from '@linuxlab/shared';

// Form for one written-test question: multiple choice or fill in the blank.

export const EMPTY_WRITTEN_QUESTION: QuestionContent = {
  title: '',
  text: '',
  points: 10,
  category: 'General',
  difficulty: 'beginner',
  setup: [],
  validation: { mode: 'all', rules: [] },
  solution: [],
  answer: { type: 'multiple_choice', choices: ['', '', '', ''], correctIndex: 0 },
};

interface WrittenQuestionFormProps {
  initial: QuestionContent;
  submitLabel: string;
  onSubmit: (content: QuestionContent) => Promise<void>;
  onCancel: () => void;
}

export function WrittenQuestionForm({ initial, submitLabel, onSubmit, onCancel }: WrittenQuestionFormProps) {
  const [q, setQ] = useState<QuestionContent>(initial);
  const key: AnswerKey = q.answer ?? { type: 'multiple_choice', choices: ['', ''], correctIndex: 0 };
  const [acceptedText, setAcceptedText] = useState(key.type === 'fill_in_blank' ? key.accepted.join('\n') : '');
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const set = <K extends keyof QuestionContent>(field: K, value: QuestionContent[K]) => setQ((prev) => ({ ...prev, [field]: value }));
  const setKey = (answer: AnswerKey) => set('answer', answer);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const answer: AnswerKey =
      key.type === 'fill_in_blank' ? { type: 'fill_in_blank', accepted: acceptedText.split('\n').map((l) => l.trim()).filter(Boolean) } : key;
    // A short title is optional here: the question text is what students read.
    const title = q.title.trim() || q.text.trim().slice(0, AUTHORING_LIMITS.titleMax);
    const checked = validateQuestionContent({ ...q, title, answer });
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
      <label>
        Question
        <textarea rows={3} value={q.text} onChange={(e) => set('text', e.target.value)} />
      </label>

      <div className="form-grid">
        <label>
          Type of answer
          <select
            value={key.type}
            onChange={(e) =>
              setKey(
                e.target.value === 'fill_in_blank'
                  ? { type: 'fill_in_blank', accepted: [] }
                  : { type: 'multiple_choice', choices: ['', '', '', ''], correctIndex: 0 },
              )
            }
          >
            <option value="multiple_choice">Multiple choice</option>
            <option value="fill_in_blank">Fill in the blank</option>
          </select>
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

      {key.type === 'multiple_choice' ? (
        <fieldset>
          <legend>Choices: select the correct one</legend>
          {key.choices.map((choice, i) => (
            <div key={i} className="row-editor">
              <input
                type="radio"
                name="correct-choice"
                aria-label={`Choice ${i + 1} is correct`}
                checked={key.correctIndex === i}
                onChange={() => setKey({ ...key, correctIndex: i })}
              />
              <input
                placeholder={`Choice ${i + 1}`}
                maxLength={AUTHORING_LIMITS.choiceMax}
                value={choice}
                onChange={(e) => setKey({ ...key, choices: key.choices.map((c, j) => (j === i ? e.target.value : c)) })}
              />
              {key.choices.length > AUTHORING_LIMITS.choicesMin && (
                <button
                  type="button"
                  className="link-button"
                  onClick={() =>
                    setKey({
                      ...key,
                      choices: key.choices.filter((_, j) => j !== i),
                      correctIndex: key.correctIndex === i ? 0 : key.correctIndex > i ? key.correctIndex - 1 : key.correctIndex,
                    })
                  }
                >
                  Remove
                </button>
              )}
            </div>
          ))}
          {key.choices.length < AUTHORING_LIMITS.choicesMax && (
            <button type="button" className="secondary" onClick={() => setKey({ ...key, choices: [...key.choices, ''] })}>
              + Add choice
            </button>
          )}
        </fieldset>
      ) : (
        <label>
          Accepted answers, one per line (capitals and extra spaces are ignored)
          <textarea rows={3} value={acceptedText} onChange={(e) => setAcceptedText(e.target.value)} />
        </label>
      )}

      <div className="form-grid">
        <label>
          Short title (optional)
          <input value={q.title} maxLength={AUTHORING_LIMITS.titleMax} onChange={(e) => set('title', e.target.value)} />
        </label>
        <label>
          Explanation (optional, for you)
          <input value={q.explanation ?? ''} onChange={(e) => set('explanation', e.target.value)} />
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
