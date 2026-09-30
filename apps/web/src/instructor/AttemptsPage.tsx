import { useEffect, useState } from 'react';
import type { AttemptSummary } from '@linuxlab/shared';
import { instructorApi } from '../api/client';
import { formatDateTime } from './format';

const AUTO_REFRESH_MS = 10_000;

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

  // Keep the list fresh during a test so locked students show up on their own.
  useEffect(() => {
    const timer = setInterval(() => setReloadKey((n) => n + 1), AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);

  const [classFilter, setClassFilter] = useState('');
  const [search, setSearch] = useState('');

  if (error) return <p className="error-text">{error}</p>;
  if (!attempts) return <p className="muted">Loading attempts…</p>;

  const classNames = [...new Set(attempts.map((a) => a.className).filter((c): c is string => !!c))].sort();
  const needle = search.trim().toLowerCase();
  const shown = attempts
    .filter(
      (a) => (!classFilter || a.className === classFilter) && (!needle || (a.studentName ?? '').toLowerCase().includes(needle)),
    )
    // Students waiting for an unlock go first.
    .sort((a, b) => Number(isLocked(b)) - Number(isLocked(a)));
  const lockedCount = attempts.filter(isLocked).length;
  // Only rows still in the list (and currently shown) count as selected.
  const chosen = shown.filter((a) => selected.has(a.id));
  const allShownSelected = shown.length > 0 && chosen.length === shown.length;
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const deleteChosen = async () => {
    if (!confirmDelete(chosen)) return;
    setDeleting(true);
    const failed: string[] = [];
    for (const a of chosen) {
      await instructorApi.deleteAttempt(a.id).catch(() => failed.push(a.studentName ?? a.id.slice(0, 8)));
    }
    setDeleting(false);
    setSelected(new Set());
    setReloadKey((n) => n + 1);
    if (failed.length > 0) window.alert(`Could not delete: ${failed.join(', ')}`);
  };

  return (
    <section>
      <div className="section-head">
        <h2>Student attempts</h2>
        <button type="button" className="secondary" onClick={() => setReloadKey((n) => n + 1)}>
          Refresh
        </button>
      </div>
      {lockedCount > 0 && (
        <p className="result result-fail">
          <strong>
            {lockedCount} student{lockedCount === 1 ? ' is' : 's are'} locked out
          </strong>{' '}
          for leaving the test screen. Go to the student, then click <em>Unlock</em> to let them continue.
        </p>
      )}
      <div className="filters">
        <label>
          Class{' '}
          <select value={classFilter} onChange={(e) => setClassFilter(e.target.value)}>
            <option value="">All classes</option>
            {classNames.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label>
          Student{' '}
          <input type="search" placeholder="Search by name" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <span className="muted">
          {shown.length} of {attempts.length} attempts
        </span>
        {chosen.length > 0 && (
          <button type="button" className="danger" disabled={deleting} onClick={() => void deleteChosen()}>
            {deleting ? 'Deleting…' : `Delete selected (${chosen.length})`}
          </button>
        )}
      </div>
      {shown.length === 0 ? (
        <p className="muted">{attempts.length === 0 ? 'No attempts yet.' : 'No attempts match the filters.'}</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col" className="select-col">
                <input
                  type="checkbox"
                  aria-label="Select all shown attempts"
                  checked={allShownSelected}
                  onChange={() => setSelected(allShownSelected ? new Set() : new Set(shown.map((a) => a.id)))}
                />
              </th>
              <th scope="col">Started</th>
              <th scope="col">Student</th>
              <th scope="col">Class</th>
              <th scope="col">Exam</th>
              <th scope="col">Status</th>
              <th scope="col" className="num">Score</th>
              <th scope="col" className="num">Submissions</th>
              <th scope="col" className="num">Commands</th>
              <th scope="col" className="num" title="Times the student left the test screen">
                Left screen
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((a) => (
              <tr key={a.id} className={`clickable ${isLocked(a) ? 'row-locked' : ''}`} onClick={() => onOpen(a.id)}>
                <td className="select-col" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    aria-label={`Select ${a.studentName ?? 'attempt'}`}
                    checked={selected.has(a.id)}
                    onChange={() => toggle(a.id)}
                  />
                </td>
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
                <td>
                  <StudentLabel summary={a} />
                </td>
                <td>{a.className ?? <span className="muted">—</span>}</td>
                <td>{a.examTitle}</td>
                <td>
                  <StatusBadge summary={a} />
                  {isLocked(a) && <UnlockButton attemptId={a.id} onUnlocked={() => setReloadKey((n) => n + 1)} />}
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
                <td className="num">
                  {a.timesLeft > 0 ? <span className="flag">{a.timesLeft}</span> : <span className="muted">0</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** Self-reported name (older attempts, from before the start screen, show their id). */
export function StudentLabel({ summary }: { summary: AttemptSummary }) {
  return summary.studentName ? (
    <span>{summary.studentName}</span>
  ) : (
    <span className="mono muted">#{summary.id.slice(0, 8)}</span>
  );
}

/** Asks before deleting; warns when students are still taking the test. */
export function confirmDelete(list: AttemptSummary[]): boolean {
  const names = list.map((a) => a.studentName ?? `#${a.id.slice(0, 8)}`);
  const shownNames = names.length > 8 ? `${names.slice(0, 8).join(', ')} and ${names.length - 8} more` : names.join(', ');
  const live = list.filter((a) => a.status === 'in_progress').length;
  const liveWarning =
    live > 0
      ? `

${live} of these ${live === 1 ? 'is' : 'are'} still in progress: the student's test ends immediately and their work is lost.`
      : '';
  return window.confirm(
    `Permanently delete ${list.length === 1 ? 'this attempt' : `${list.length} attempts`} (${shownNames})?

Scores, answers and command history are removed and cannot be recovered.${liveWarning}`,
  );
}

export function isLocked(summary: AttemptSummary): boolean {
  return summary.status === 'in_progress' && summary.lockedAt !== null;
}

/** Lets a student who left the test screen continue. */
export function UnlockButton({ attemptId, onUnlocked }: { attemptId: string; onUnlocked: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="unlock-button"
      disabled={busy}
      onClick={(e) => {
        e.stopPropagation();
        setBusy(true);
        instructorApi
          .unlock(attemptId)
          .then(onUnlocked)
          .catch((err: unknown) => window.alert(err instanceof Error ? err.message : String(err)))
          .finally(() => setBusy(false));
      }}
    >
      {busy ? 'Unlocking…' : 'Unlock'}
    </button>
  );
}

export function StatusBadge({ summary }: { summary: AttemptSummary }) {
  if (isLocked(summary)) {
    return (
      <span className="badge badge-locked" title={summary.lockReason ?? undefined}>
        🔒 Locked
      </span>
    );
  }
  if (summary.status === 'in_progress') return <span className="badge badge-live">In progress</span>;
  if (summary.endReason === 'time_expired') return <span className="badge badge-warn">Time expired</span>;
  return <span className="badge badge-done">Finished</span>;
}
