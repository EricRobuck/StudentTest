import { useEffect, useState, type FormEvent } from 'react';
import { STUDENT_LIMITS, validateStudentInfo, type StudentInfo } from '@linuxlab/shared';
import { api } from '../api/client';

type FieldErrors = Partial<Record<keyof StudentInfo, string>>;

/** Before the exam: the student enters their name and class. */
export function StartScreen({ onStarted }: { onStarted: () => void }) {
  // undefined = still loading; null = free-text class; array = dropdown.
  const [classes, setClasses] = useState<string[] | null | undefined>(undefined);
  const [name, setName] = useState('');
  const [className, setClassName] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    api
      .classes(controller.signal)
      .then((r) => {
        setClasses(r.classes);
        if (r.classes?.length === 1) setClassName(r.classes[0]!);
      })
      .catch(() => {
        if (!controller.signal.aborted) setClasses(null);
      });
    return () => controller.abort();
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setServerError(null);
    // Same rules as the server, for instant feedback. The server re-checks.
    const checked = validateStudentInfo({ name, className }, classes ?? null);
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    setStarting(true);
    try {
      await api.startSession(checked.value);
      onStarted();
    } catch (err) {
      setServerError(err instanceof Error ? err.message : String(err));
      setStarting(false);
    }
  };

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
        autoFocus
      />
      {errors.name && (
        <p id="student-name-error" className="field-error">
          {errors.name}
        </p>
      )}

      <label htmlFor="student-class">What class is this?</label>
      {classes ? (
        <select
          id="student-class"
          value={className}
          onChange={(e) => setClassName(e.target.value)}
          aria-invalid={errors.className ? true : undefined}
          aria-describedby={errors.className ? 'student-class-error' : undefined}
        >
          <option value="">Choose your class…</option>
          {classes.map((c) => (
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
          disabled={classes === undefined}
        />
      )}
      {errors.className && (
        <p id="student-class-error" className="field-error">
          {errors.className}
        </p>
      )}

      {serverError && <p className="result result-error">{serverError}</p>}

      <button type="submit" disabled={starting || classes === undefined}>
        {starting ? 'Preparing your Linux environment…' : 'Start exam'}
      </button>
      <p className="muted small">
        Use your real name: your answers and results are recorded under it. The timer starts when you click Start exam.
      </p>
    </form>
  );
}
