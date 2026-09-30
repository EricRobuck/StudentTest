import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { STUDENT_LIMITS, validateStudentInfo, type StartOptionsResponse, type StudentInfo } from '@linuxlab/shared';
import { api } from '../api/client';

type FieldErrors = Partial<Record<keyof StudentInfo | 'examId', string>>;

interface StartScreenProps {
  onStarted: () => void;
  /** Pre-filled when a student comes back to take another test. */
  initial?: StudentInfo;
}

/** Before a test: the student enters their name and class and chooses a test. */
export function StartScreen({ onStarted, initial }: StartScreenProps) {
  const [options, setOptions] = useState<StartOptionsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState(initial?.name ?? '');
  const [className, setClassName] = useState(initial?.className ?? '');
  const [examId, setExamId] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const o = await api.startOptions();
      setOptions(o);
      if (o.classes?.length === 1) setClassName((c) => c || o.classes![0]!);
      // Pre-select only when there is exactly one test; otherwise the student must choose.
      setExamId((id) => (o.exams.some((e) => e.id === id) ? id : o.exams.length === 1 ? o.exams[0]!.id : ''));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setServerError(null);
    // Same rules as the server, for instant feedback. The server re-checks.
    const checked = validateStudentInfo({ name, className }, options?.classes ?? null);
    const next: FieldErrors = checked.ok ? {} : { ...checked.errors };
    if (!examId) next.examId = 'Please choose a test.';
    setErrors(next);
    if (!checked.ok || !examId) return;
    setStarting(true);
    try {
      await api.startSession({ ...checked.value, examId });
      onStarted();
    } catch (err) {
      setServerError(err instanceof Error ? err.message : String(err));
      setStarting(false);
      void load(); // the list of open tests may have changed
    }
  };

  if (loadError) {
    return (
      <div className="start-card">
        <p className="error-text">Could not load the start screen: {loadError}</p>
        <button type="button" onClick={() => void load()}>
          Try again
        </button>
      </div>
    );
  }
  if (!options) return <p className="muted">Loading…</p>;

  return (
    <form className="start-card" onSubmit={(e) => void submit(e)} noValidate>
      <label htmlFor="student-name">What is your name?</label>
      <input
        id="student-name"
        autoComplete="name"
        maxLength={STUDENT_LIMITS.nameMax}
        value={name}
        onChange={(e) => setName(e.target.value)}
        aria-invalid={errors.name ? true : undefined}
        aria-describedby={errors.name ? 'student-name-error' : undefined}
        autoFocus={!initial}
      />
      {errors.name && (
        <p id="student-name-error" className="field-error">
          {errors.name}
        </p>
      )}

      <label htmlFor="student-class">What class is this?</label>
      {options.classes ? (
        <select
          id="student-class"
          value={className}
          onChange={(e) => setClassName(e.target.value)}
          aria-invalid={errors.className ? true : undefined}
          aria-describedby={errors.className ? 'student-class-error' : undefined}
        >
          <option value="">Choose your class…</option>
          {options.classes.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      ) : (
        <input
          id="student-class"
          placeholder="e.g. CS120"
          maxLength={STUDENT_LIMITS.classMax}
          value={className}
          onChange={(e) => setClassName(e.target.value)}
          aria-invalid={errors.className ? true : undefined}
          aria-describedby={errors.className ? 'student-class-error' : undefined}
        />
      )}
      {errors.className && (
        <p id="student-class-error" className="field-error">
          {errors.className}
        </p>
      )}

      <fieldset className="test-choice" aria-describedby={errors.examId ? 'exam-error' : undefined}>
        <legend>Which test are you taking?</legend>
        {options.exams.length === 0 ? (
          <div className="result result-error">
            No tests are open right now. Please check with your instructor.{' '}
            <button type="button" className="link-button" onClick={() => void load()}>
              Check again
            </button>
          </div>
        ) : (
          options.exams.map((exam) => (
            <label key={exam.id} className={`test-option ${examId === exam.id ? 'selected' : ''}`}>
              <input type="radio" name="exam" value={exam.id} checked={examId === exam.id} onChange={() => setExamId(exam.id)} />
              <span>
                <strong>{exam.title}</strong>
                <span className="muted small">
                  {' '}
                  · {exam.questionCount} question{exam.questionCount === 1 ? '' : 's'} · {exam.totalPoints} points ·{' '}
                  {exam.timeLimitMinutes ? `${exam.timeLimitMinutes} minutes` : 'no time limit'} ·{' '}
                  {exam.mode === 'exam' ? 'one attempt' : 'practice'}
                </span>
                {exam.description && <span className="muted small test-description">{exam.description}</span>}
              </span>
            </label>
          ))
        )}
        {errors.examId && (
          <p id="exam-error" className="field-error">
            {errors.examId}
          </p>
        )}
      </fieldset>

      {options.exams.find((e) => e.id === examId)?.lockOnLeave && (
        <p className="result result-warning">
          <strong>Stay on the test screen.</strong> Once you start, do not switch tabs, open other windows or apps, or
          close this page. If you leave, your test locks and you will have to call your instructor over to unlock it.
        </p>
      )}

      {serverError && <p className="result result-error">{serverError}</p>}

      <button type="submit" disabled={starting || options.exams.length === 0}>
        {starting ? 'Preparing your Linux environment…' : 'Start test'}
      </button>
      <p className="muted small">
        Use your real name: your answers and results are recorded under it. The timer starts when you click Start test.
      </p>
    </form>
  );
}
