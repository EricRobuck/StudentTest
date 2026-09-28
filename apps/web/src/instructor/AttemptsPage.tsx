import { useEffect, useState } from 'react';
import type { AttemptSummary } from '@linuxlab/shared';
import { instructorApi } from '../api/client';
import { formatDateTime } from './format';

export function AttemptsPage({ onOpen }: { onOpen: (attemptId: string) => void }) {
  const [attempts, setAttempts] = useState<AttemptSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    instructorApi
      .attempts(controller.signal)
      .then(setAttempts)
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err));
      });
    return () => controller.abort();
  }, [reloadKey]);

  if (error) return <p className="error-text">{error}</p>;
  if (!attempts) return <p className="muted">Loading attempts…</p>;

  return (
    <section>
      <div className="section-head">
        <h2>Student attempts</h2>
        <button type="button" className="secondary" onClick={() => setReloadKey((n) => n + 1)}>
          Refresh
        </button>
      </div>
      {attempts.length === 0 ? (
        <p className="muted">No attempts yet.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Started</th>
              <th scope="col">Student</th>
              <th scope="col">Exam</th>
              <th scope="col">Status</th>
              <th scope="col" className="num">Score</th>
              <th scope="col" className="num">Submissions</th>
              <th scope="col" className="num">Commands</th>
            </tr>
          </thead>
          <tbody>
            {attempts.map((a) => (
              <tr key={a.id} className="clickable" onClick={() => onOpen(a.id)}>
                <td>
                  <a
                    href={`/instructor/attempts/${a.id}`}
                    onClick={(e) => {
                      e.preventDefault();
                      onOpen(a.id);
                    }}
                  >
                    {formatDateTime(a.startedAt)}
                  </a>
                </td>
                {/* No sign-in for students yet: identify attempts by a short id. */}
                <td className="mono">#{a.id.slice(0, 8)}</td>
                <td>{a.examTitle}</td>
                <td>
                  <StatusBadge summary={a} />
                </td>
                <td className="num">
                  {a.score.earned}/{a.score.max} <span className="muted">({a.percentage}%)</span>
                </td>
                <td className="num">{a.submissionCount}</td>
                <td className="num">
                  {a.commandCount}
                  {a.flaggedCommandCount > 0 && (
                    <span className="flag" title="Commands that touched the command logger">
                      {' '}
                      ⚠ {a.flaggedCommandCount}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function StatusBadge({ summary }: { summary: AttemptSummary }) {
  if (summary.status === 'in_progress') return <span className="badge badge-live">In progress</span>;
  if (summary.endReason === 'time_expired') return <span className="badge badge-warn">Time expired</span>;
  return <span className="badge badge-done">Finished</span>;
}
