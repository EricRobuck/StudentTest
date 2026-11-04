import { useCallback, useEffect, useState } from 'react';
import type { GradingAnswer, GradingQuestion, GradingQueue } from '@linuxlab/shared';
import { instructorApi } from '../api/client';
import { TaskText } from '../components/TaskText';

/** Grade short answers one question at a time, across all students. AI only suggests. */
export function GradingPage({ examId, onBack }: { examId: string; onBack: () => void }) {
  const [queue, setQueue] = useState<GradingQueue | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setQueue(await instructorApi.gradingQueue(examId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [examId]);
  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <p className="error-text">{error}</p>;
  if (!queue) return <p className="muted">Loading answers…</p>;

  return (
    <article>
      <button type="button" className="link-button" onClick={onBack}>
        ← Back to the test
      </button>
      <div className="section-head">
        <h2>Grade short answers{queue.examTitle ? `: ${queue.examTitle}` : ''}</h2>
      </div>
      {queue.questions.length === 0 ? (
        <p className="muted">No short answers to grade yet. They appear here once students finish the test.</p>
      ) : (
        <>
          <p className="muted small">
            AI only suggests: nothing counts until you save or accept it. Only the question, your rubric and the answers go
            to OpenAI, never student names, though a student could write their name in an answer.
          </p>
          {queue.questions.map((q) => (
            <QuestionGrading key={q.questionId} examId={examId} question={q} aiEnabled={queue.aiEnabled} onChanged={load} />
          ))}
        </>
      )}
    </article>
  );
}

function QuestionGrading({
  examId,
  question: q,
  aiEnabled,
  onChanged,
}: {
  examId: string;
  question: GradingQuestion;
  aiEnabled: boolean;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const ungraded = q.answers.filter((a) => a.points === null);
  const needSuggestion = ungraded.filter((a) => !a.suggestion);
  const toAccept = ungraded.filter((a) => a.suggestion);

  const suggest = async () => {
    setBusy('suggest');
    setMessage(null);
    try {
      const r = await instructorApi.suggestGrades(examId, q.questionId);
      setMessage({ ok: true, text: `AI suggested ${r.suggested} grade(s)${r.remaining ? `; ${r.remaining} could not be graded, so try again` : ''}. Review them, then save or accept.` });
      await onChanged();
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const acceptAll = async () => {
    if (!window.confirm(`Accept all ${toAccept.length} AI suggestion(s) for this question as final grades?`)) return;
    setBusy('accept');
    setMessage(null);
    try {
      for (const a of toAccept) await instructorApi.setPoints(a.attemptId, q.questionId, a.suggestion!.points);
      setMessage({ ok: true, text: `Accepted ${toAccept.length} grade(s).` });
      await onChanged();
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="panel">
      <div className="section-head">
        <h3>{q.title}</h3>
        <span className="muted">
          {q.answers.length - ungraded.length} of {q.answers.length} graded · {q.maxPoints} points
        </span>
      </div>
      <p>
        <TaskText text={q.text} />
      </p>
      <p className="small">
        <strong>Rubric:</strong> {q.rubric}
      </p>
      {q.sampleAnswer && (
        <p className="small">
          <strong>Sample answer:</strong> {q.sampleAnswer}
        </p>
      )}
      <div className="action-row">
        {aiEnabled ? (
          <button type="button" disabled={busy !== null || needSuggestion.length === 0} onClick={() => void suggest()}>
            {busy === 'suggest' ? 'AI is grading…' : `AI: suggest grades (${needSuggestion.length})`}
          </button>
        ) : (
          <span className="muted small">AI grading is not set up: add OPENAI_API_KEY to the .env file.</span>
        )}
        <button type="button" className="secondary" disabled={busy !== null || toAccept.length === 0} onClick={() => void acceptAll()}>
          {busy === 'accept' ? 'Accepting…' : `Accept all AI suggestions (${toAccept.length})`}
        </button>
      </div>
      {message && (
        <p className={`result ${message.ok ? 'result-pass' : 'result-error'}`} role="status">
          {message.text}
        </p>
      )}
      {q.answers.length === 0 ? (
        <p className="muted">No one has answered this question yet.</p>
      ) : (
        <table className="data-table grading-table">
          <thead>
            <tr>
              <th scope="col">Student</th>
              <th scope="col">Answer</th>
              <th scope="col">AI suggestion</th>
              <th scope="col">Grade</th>
            </tr>
          </thead>
          <tbody>
            {q.answers.map((a) => (
              <AnswerRow key={a.attemptId} questionId={q.questionId} maxPoints={q.maxPoints} answer={a} onChanged={onChanged} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function AnswerRow({
  questionId,
  maxPoints,
  answer: a,
  onChanged,
}: {
  questionId: string;
  maxPoints: number;
  answer: GradingAnswer;
  onChanged: () => Promise<void>;
}) {
  const [points, setPoints] = useState(String(a.points ?? a.suggestion?.points ?? ''));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A new suggestion or grade from the server fills the box, unless the instructor has typed.
  useEffect(() => {
    setPoints(String(a.points ?? a.suggestion?.points ?? ''));
  }, [a.points, a.suggestion?.points]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await instructorApi.setPoints(a.attemptId, questionId, Number(points));
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const value = Number(points);
  const usable = points.trim() !== '' && Number.isFinite(value) && value >= 0 && value <= maxPoints;
  const unchanged = a.points !== null && value === a.points;

  return (
    <tr className={a.points === null ? 'row-ungraded' : undefined}>
      <td>
        {a.studentName ?? <span className="muted">Unnamed</span>}
        {a.className && <div className="muted small">{a.className}</div>}
      </td>
      <td className="student-answer">{a.answer || <span className="muted">(no answer)</span>}</td>
      <td className="small">
        {a.suggestion ? (
          <>
            <strong>
              {a.suggestion.points}/{maxPoints}
            </strong>{' '}
            {a.suggestion.reasoning}
          </>
        ) : (
          <span className="muted">None</span>
        )}
      </td>
      <td>
        <span className="action-row grade-points">
          <input
            type="number"
            min={0}
            max={maxPoints}
            step={0.5}
            aria-label={`Points for ${a.studentName ?? 'this student'}`}
            value={points}
            onChange={(e) => setPoints(e.target.value)}
          />
          <span className="muted small">/{maxPoints}</span>
          <button type="button" className="small-button" disabled={saving || !usable || unchanged} onClick={() => void save()}>
            {a.points === null ? (a.suggestion && value === a.suggestion.points ? 'Accept' : 'Save') : 'Update'}
          </button>
        </span>
        {a.points !== null && <div className="pass small">✓ Graded</div>}
        {error && <div className="fail small">{error}</div>}
      </td>
    </tr>
  );
}
