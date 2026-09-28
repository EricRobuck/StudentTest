import { useState } from 'react';
import type { ExamResultView } from '@linuxlab/shared';

interface ResultsViewProps {
  result: ExamResultView;
  /** Starts a fresh practice attempt; only offered when the exam allows retakes. */
  onStartOver: () => Promise<void>;
}

/** Final results after the exam ends (requirements §16). */
export function ResultsView({ result, onStartOver }: ResultsViewProps) {
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
      {result.canRetake && (
        <div className="results-actions">
          <button type="button" onClick={() => void startOver()} disabled={starting}>
            {starting ? 'Starting…' : 'Start a new attempt'}
          </button>
          <span className="muted">Practice mode: you get a fresh Linux environment and a new score.</span>
          {error && <p className="error-text">{error}</p>}
        </div>
      )}
      <h2>{result.examTitle}</h2>
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
