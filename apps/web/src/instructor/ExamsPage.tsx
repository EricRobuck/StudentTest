import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { ExamSummary } from '@linuxlab/shared';
import { instructorApi } from '../api/client';

/** Whether students can choose this test on the start screen. */
export function OpenBadge({ exam }: { exam: ExamSummary }) {
  if (exam.open) return <span className="badge badge-done">Open</span>;
  if (exam.enabled) return <span className="badge badge-warn" title="Enabled, but no approved questions yet">Enabled, no approved questions</span>;
  return <span className="badge">Closed</span>;
}

/** All tests: which are open to students, how many questions are approved, create new. */
export function ExamsPage({ onOpen }: { onOpen: (examId: string) => void }) {
  const [exams, setExams] = useState<ExamSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setExams(await instructorApi.exams(signal));
    } catch (err) {
      if (!signal?.aborted) setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const toggle = async (exam: ExamSummary) => {
    setToggling(exam.id);
    setError(null);
    try {
      await instructorApi.setExamEnabled(exam.id, !exam.enabled);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    await load();
    setToggling(null);
  };

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const exam = await instructorApi.createExam(title);
      onOpen(exam.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setCreating(false);
    }
  };

  return (
    <section>
      <div className="section-head">
        <h2>Exams</h2>
      </div>
      {error && <p className="error-text">{error}</p>}
      {!exams ? (
        <p className="muted">Loading exams…</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Exam</th>
              <th scope="col">Open to students</th>
              <th scope="col" className="num">Approved</th>
              <th scope="col" className="num">Drafts</th>
              <th scope="col" className="num">Points</th>
              <th scope="col">Mode</th>
            </tr>
          </thead>
          <tbody>
            {exams.map((e) => (
              <tr key={e.id} className="clickable" onClick={() => onOpen(e.id)}>
                <td>
                  <a
                    href={`/instructor/exams/${e.id}`}
                    onClick={(ev) => {
                      ev.preventDefault();
                      onOpen(e.id);
                    }}
                  >
                    {e.title}
                  </a>
                </td>
                <td onClick={(ev) => ev.stopPropagation()}>
                  <span className="action-row">
                    <OpenBadge exam={e} />
                    <button
                      type="button"
                      className="secondary small-button"
                      disabled={toggling === e.id || (!e.enabled && e.approvedCount === 0)}
                      title={!e.enabled && e.approvedCount === 0 ? 'Approve at least one question first' : undefined}
                      onClick={() => void toggle(e)}
                    >
                      {e.enabled ? 'Disable' : 'Enable'}
                    </button>
                  </span>
                </td>
                <td className="num">{e.approvedCount}</td>
                <td className="num">{e.draftCount}</td>
                <td className="num">{e.totalPoints}</td>
                <td>{e.settings.mode}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <form className="panel inline-form" onSubmit={(e) => void create(e)}>
        <label htmlFor="new-exam-title">New exam</label>
        <input
          id="new-exam-title"
          placeholder="e.g. Week 5 — Permissions quiz"
          maxLength={120}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <button type="submit" disabled={creating || title.trim().length === 0}>
          {creating ? 'Creating…' : 'Create exam'}
        </button>
      </form>
    </section>
  );
}
