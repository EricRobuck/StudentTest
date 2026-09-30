import { useEffect, useState } from 'react';
import type {
  AttemptDetail,
  FsSnapshotView,
  InstructorCommand,
  InstructorQuestionDetail,
  ValidatorSpec,
} from '@linuxlab/shared';
import { instructorApi } from '../api/client';
import { TaskText } from '../components/TaskText';
import { confirmDelete, isLocked, StatusBadge, StudentLabel, UnlockButton } from './AttemptsPage';
import { formatDateTime, formatSeconds, formatTime, printable } from './format';

export function AttemptDetailPage({ attemptId, onBack }: { attemptId: string; onBack: () => void }) {
  const [detail, setDetail] = useState<AttemptDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    instructorApi
      .attempt(attemptId, controller.signal)
      .then(setDetail)
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err));
      });
    return () => controller.abort();
  }, [attemptId, reloadKey]);

  if (error) return <p className="error-text">{error}</p>;
  if (!detail) return <p className="muted">Loading attempt…</p>;
  const s = detail.summary;

  return (
    <article className="attempt-detail">
      <button type="button" className="link-button" onClick={onBack}>
        ← All attempts
      </button>

      <section className="panel">
        <div className="section-head">
          <h2>
            <StudentLabel summary={s} />
            {s.className && <span className="muted"> · {s.className}</span>}
          </h2>
          <div className="header-right">
            <StatusBadge summary={s} />
            {isLocked(s) && <UnlockButton attemptId={s.id} onUnlocked={() => setReloadKey((n) => n + 1)} />}
            <button
              type="button"
              className="danger"
              onClick={() => {
                if (!confirmDelete([s])) return;
                instructorApi
                  .deleteAttempt(s.id)
                  .then(onBack)
                  .catch((err: unknown) => window.alert(err instanceof Error ? err.message : String(err)));
              }}
            >
              Delete attempt
            </button>
          </div>
        </div>
        {isLocked(s) && (
          <p className="result result-fail">
            Locked at {formatDateTime(s.lockedAt)}: the student {s.lockReason ?? 'left the test screen'}.
          </p>
        )}
        <dl className="facts">
          <dt>Exam</dt>
          <dd>
            {s.examTitle} <span className="mono muted">(attempt #{s.id.slice(0, 8)})</span>
          </dd>
          <dt>Score</dt>
          <dd>
            <strong>
              {s.score.earned} / {s.score.max}
            </strong>{' '}
            ({s.percentage}%)
          </dd>
          <dt>Started</dt>
          <dd>{formatDateTime(s.startedAt)}</dd>
          <dt>Ended</dt>
          <dd>{formatDateTime(s.completedAt)}</dd>
          <dt>Submissions</dt>
          <dd>{s.submissionCount}</dd>
          <dt>Commands</dt>
          <dd>
            {s.commandCount}
            {s.flaggedCommandCount > 0 && <span className="flag"> · ⚠ {s.flaggedCommandCount} flagged</span>}
          </dd>
          <dt>Left the screen</dt>
          <dd>{s.timesLeft === 0 ? 'Never' : <span className="flag">{s.timesLeft} time{s.timesLeft === 1 ? '' : 's'}</span>}</dd>
        </dl>
        {detail.integrityEvents.length > 0 && (
          <>
            <h3>Leaving the test screen</h3>
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">What happened</th>
                </tr>
              </thead>
              <tbody>
                {detail.integrityEvents.map((e, i) => (
                  <tr key={i}>
                    <td>{formatDateTime(e.at)}</td>
                    <td>{e.type === 'left' ? <span className="flag">🔒 Locked: {e.reason}</span> : `🔓 ${e.reason}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>

      {detail.questions.map((q) => (
        <QuestionSection key={q.questionId} question={q} />
      ))}

      {detail.unassignedCommands.length > 0 && (
        <section className="panel">
          <h3>Commands not linked to a question</h3>
          <CommandTable commands={detail.unassignedCommands} />
        </section>
      )}

      <SnapshotSection snapshot={detail.snapshot} inProgress={s.status === 'in_progress'} />
    </article>
  );
}

function QuestionSection({ question: q }: { question: InstructorQuestionDetail }) {
  return (
    <section className="panel">
      <div className="section-head">
        <h3>
          {q.number}. {q.title}
        </h3>
        <span className={q.passed ? 'pass' : 'fail'}>
          {q.passed ? '✓' : '✗'} {q.pointsAwarded}/{q.maxPoints} points
        </span>
      </div>
      <p>
        <TaskText text={q.text} />
      </p>
      <p className="muted small">
        Time on question: {formatSeconds(q.timeSpentSeconds)} · Checks ({q.validation.mode === 'all' ? 'all required' : 'any one'}):{' '}
        {q.validation.rules.map(describeRule).join('; ')}
      </p>

      <h4>Submissions ({q.submissions.length})</h4>
      {q.submissions.length === 0 ? (
        <p className="muted">Not submitted.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Time</th>
              <th scope="col">Result</th>
              <th scope="col">Checks (what the grader saw)</th>
            </tr>
          </thead>
          <tbody>
            {q.submissions.map((sub) => (
              <tr key={sub.attemptNumber}>
                <td>{sub.attemptNumber}</td>
                <td>{formatTime(sub.submittedAt)}</td>
                <td className={sub.passed ? 'pass' : 'fail'}>
                  {sub.passed ? '✓' : '✗'} {sub.pointsAwarded}/{sub.maxPoints}
                </td>
                <td>
                  <ul className="plain">
                    {sub.rules.map((r, i) => (
                      <li key={i}>
                        <span className={r.passed ? 'pass' : 'fail'}>{r.passed ? '✓' : '✗'}</span> {r.message}
                        {r.detail && <div className="mono muted small">{printable(r.detail)}</div>}
                      </li>
                    ))}
                  </ul>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h4>Commands while on this question ({q.commands.length})</h4>
      {q.commands.length === 0 ? <p className="muted">None.</p> : <CommandTable commands={q.commands} />}
    </section>
  );
}

function CommandTable({ commands }: { commands: InstructorCommand[] }) {
  return (
    <table className="data-table commands">
      <thead>
        <tr>
          <th scope="col">Time</th>
          <th scope="col">Directory</th>
          <th scope="col">Command</th>
          <th scope="col" className="num">Exit</th>
        </tr>
      </thead>
      <tbody>
        {commands.map((c) => (
          <tr key={c.seq} className={c.flags.length ? 'flagged' : undefined}>
            <td className="mono">{formatTime(c.executedAt)}</td>
            <td className="mono">{printable(c.cwd)}</td>
            <td className="mono pre">
              {printable(c.command)}
              {c.flags.length > 0 && <span className="flag"> ⚠ {c.flags.join(', ')}</span>}
            </td>
            <td className={`num mono ${c.exitCode ? 'fail' : ''}`}>{c.exitCode ?? '?'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SnapshotSection({ snapshot, inProgress }: { snapshot: FsSnapshotView | null; inProgress: boolean }) {
  if (!snapshot) {
    return (
      <section className="panel">
        <h3>Final filesystem state</h3>
        <p className="muted">
          {inProgress
            ? 'Captured automatically when the exam ends.'
            : 'No snapshot was captured for this attempt (it ended before snapshots existed, or the environment was already gone).'}
        </p>
      </section>
    );
  }
  return (
    <section className="panel">
      <h3>Final filesystem state</h3>
      <p className="muted small">
        Captured {formatDateTime(snapshot.takenAt)} from {snapshot.roots.join(', ')}
        {snapshot.truncated && ' (listing truncated)'}.
      </p>
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">Permissions</th>
            <th scope="col">Owner</th>
            <th scope="col" className="num">Size</th>
            <th scope="col">Path</th>
          </tr>
        </thead>
        <tbody>
          {snapshot.entries.map((e) => (
            <tr key={e.path}>
              <td className="mono">
                {typeChar(e.type)}
                {e.mode.padStart(3, '0')}
              </td>
              <td className="mono">
                {e.owner}:{e.group}
              </td>
              <td className="num mono">{e.type === 'directory' ? '' : e.size}</td>
              <td className="mono">
                {printable(e.path)}
                {e.type === 'directory' && '/'}
                {e.target !== undefined && <span className="muted"> → {printable(e.target)}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {snapshot.files.length > 0 && (
        <>
          <h4>Small file contents</h4>
          {snapshot.files.map((f) => (
            <details key={f.path}>
              <summary className="mono">{printable(f.path)}</summary>
              <pre className="file-content">
                {printable(f.content) || <span className="muted">(empty)</span>}
                {f.truncated && '\n… (truncated)'}
              </pre>
            </details>
          ))}
        </>
      )}
    </section>
  );
}

function typeChar(type: string): string {
  return type === 'directory' ? 'd ' : type === 'symlink' ? 'l ' : type === 'file' ? '- ' : '? ';
}

function describeRule(rule: ValidatorSpec): string {
  switch (rule.type) {
    case 'current_directory':
      return `terminal in ${rule.path}`;
    case 'directory_exists':
      return `directory ${rule.path} exists`;
    case 'file_exists':
      return `file ${rule.path} exists`;
    case 'file_contains':
      return `${rule.path} contains "${rule.text}"`;
    case 'file_permissions':
      return `${rule.path} has mode ${rule.mode}`;
  }
}
