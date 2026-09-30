import { useState } from 'react';
import type { ExamResultView } from '@linuxlab/shared';

interface ResultsViewProps {
  result: ExamResultView;
  /** Starts a fresh practice attempt; only offered when the exam allows retakes. */
  onStartOver: () => Promise<void>;
  /** Back to the start screen to choose a different test. */
  onTakeAnother: () => void;
}

/** Final results after the exam ends (requirements §16). */
export function ResultsView({ result, onStartOver, onTakeAnother }: ResultsViewProps) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startOver = async () => {
    setStarting(true);
    setError(null);
    try {
      await onStartOver();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStarting(false);
    }
  };

  return (
    <section className="results" aria-label="Exam results">
      <div className="results-actions">
        {result.canRetake && (
          <button type="button" onClick={() => void startOver()} disabled={starting}>
            {starting ? 'Starting…' : 'Try this test again'}
          </button>
        )}
        <button type="button" className="secondary" onClick={onTakeAnother} disabled={starting}>
          Take another test
        </button>
        {result.canRetake && <span className="muted">Practice test: a retake gives you a fresh Linux environment and a new score.</span>}
        {error && <p className="error-text">{error}</p>}
      </div>
      <h2>{result.examTitle}</h2>
      {result.studentName && (
        <p className="results-student">
          Student: <strong>{result.studentName}</strong>
          {result.className && <> · {result.className}</>}
        </p>
      )}
      <p className="muted">
        {result.endReason === 'time_expired' ? 'Time ran out — your exam was submitted automatically.' : 'Exam finished.'}{' '}
        Completed {new Date(result.completedAt).toLocaleString()}.
      </p>

      <div className="results-score">
        <span className="results-points">
          {result.score.earned} / {result.score.max}
        </span>
        <span className="results-percent">{result.percentage}%</span>
      </div>

      <table className="results-table">
        <thead>
          <tr>
            <th scope="col">Question</th>
            <th scope="col">Result</th>
            <th scope="col">Attempts</th>
            <th scope="col" className="num">
              Points
            </th>
          </tr>
        </thead>
        <tbody>
          {result.questions.map((q) => (
            <tr key={q.questionId}>
              <td>
                {q.number}. {q.title}
              </td>
              <td className={q.passed ? 'pass' : 'fail'}>
                {q.passed ? '✓ Correct' : q.attempts === 0 ? '— Not answered' : '✗ Incorrect'}
              </td>
              <td>{q.attempts}</td>
              <td className="num">
                {q.pointsAwarded}/{q.maxPoints}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" colSpan={3}>
              Total
            </th>
            <td className="num">
              <strong>
                {result.score.earned}/{result.score.max}
              </strong>
            </td>
          </tr>
        </tfoot>
      </table>
    </section>
  );
}
