import { useEffect, useState } from 'react';
import type { ExamAnalysis, QuestionAnalysis, QuestionFormat } from '@linuxlab/shared';
import { instructorApi } from '../api/client';
import { TaskText } from '../components/TaskText';

const FORMAT_LABEL: Record<QuestionFormat, string> = {
  linux: 'Linux task',
  multiple_choice: 'Multiple choice',
  fill_in_blank: 'Fill in the blank',
  short_answer: 'Short answer',
};

/** Below this share correct, a question is worth a second look. */
const HARD_BELOW = 50;

/** How each question of a test went across all finished attempts. */
export function AnalysisPage({ examId, onBack }: { examId: string; onBack: () => void }) {
  const [analysis, setAnalysis] = useState<ExamAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hardestFirst, setHardestFirst] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    instructorApi
      .examAnalysis(examId, controller.signal)
      .then(setAnalysis)
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err));
      });
    return () => controller.abort();
  }, [examId]);

  if (error) return <p className="error-text">{error}</p>;
  if (!analysis) return <p className="muted">Loading…</p>;

  const questions = hardestFirst
    ? [...analysis.questions].sort((a, b) => (a.percentCorrect ?? 101) - (b.percentCorrect ?? 101))
    : analysis.questions;

  return (
    <article>
      <button type="button" className="link-button" onClick={onBack}>
        ← Back
      </button>
      <div className="section-head">
        <h2>Question analysis{analysis.examTitle ? `: ${analysis.examTitle}` : ''}</h2>
        {analysis.questions.length > 1 && (
          <label className="muted small">
            <input type="checkbox" checked={hardestFirst} onChange={(e) => setHardestFirst(e.target.checked)} /> Hardest first
          </label>
        )}
      </div>
      {analysis.finishedAttempts === 0 ? (
        <p className="muted">No finished attempts yet. This fills in as students finish the test.</p>
      ) : (
        <>
          <p className="muted">
            From {analysis.finishedAttempts} finished attempt{analysis.finishedAttempts === 1 ? '' : 's'}, including any grades you
            changed. A question left blank counts as not correct. Partly right answers don't count as correct, but they do count
            in the average points.
          </p>
          {questions.map((q) => (
            <QuestionCard key={q.questionId} q={q} />
          ))}
        </>
      )}
    </article>
  );
}

function QuestionCard({ q }: { q: QuestionAnalysis }) {
  const hard = q.percentCorrect !== null && q.percentCorrect < HARD_BELOW;
  return (
    <section className="panel">
      <div className="section-head">
        <h3>
          {q.number}. {q.title}
        </h3>
        <span className="action-row">
          <span className="badge">{FORMAT_LABEL[q.format]}</span>
          {hard && <span className="badge badge-warn">Hard</span>}
        </span>
      </div>
      <p>
        <TaskText text={q.text} />
      </p>
      <div className="analysis-numbers">
        <Stat label="Got it right" value={q.percentCorrect === null ? '—' : `${q.percentCorrect}%`} />
        <Stat label="Average points" value={q.averagePoints === null ? '—' : `${q.averagePoints} / ${q.maxPoints}`} />
        <Stat label="Answered" value={`${q.answered} of ${q.attempts}`} />
        {q.averageTries !== undefined && <Stat label="Average tries" value={String(q.averageTries)} />}
      </div>
      {q.percentCorrect !== null && (
        <div className="bar" role="presentation">
          <span className={hard ? 'bar-fill bar-hard' : 'bar-fill'} style={{ width: `${q.percentCorrect}%` }} />
        </div>
      )}
      {q.pending > 0 && <p className="result result-error">{q.pending} answer(s) still need grading, so these numbers leave them out.</p>}

      {q.choices && <ChoiceBars q={q} />}

      {q.wrongAnswers && q.wrongAnswers.length > 0 && (
        <>
          <h4>Most common wrong answers</h4>
          <ul className="plain">
            {q.wrongAnswers.map((w) => (
              <li key={w.answer}>
                <span className="mono">{w.answer}</span> <span className="muted">({w.count})</span>
              </li>
            ))}
          </ul>
          <p className="muted small">If one of these should count, add it to the question's accepted answers, or change those grades by hand.</p>
        </>
      )}

      {q.checks && q.checks.length > 0 && (
        <>
          <h4>Checks on the last submission</h4>
          <ul className="plain">
            {q.checks.map((c) => (
              <li key={c.label}>
                <span className="mono small">{c.label}</span>{' '}
                <span className={c.passed < c.total / 2 ? 'fail' : 'pass'}>
                  {c.passed} of {c.total} passed
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="analysis-value">{value}</div>
      <div className="muted small">{label}</div>
    </div>
  );
}

function ChoiceBars({ q }: { q: QuestionAnalysis }) {
  const total = q.choices!.reduce((sum, c) => sum + c.count, 0);
  return (
    <>
      <h4>What students picked</h4>
      <ul className="plain choice-bars">
        {q.choices!.map((c) => {
          const share = total === 0 ? 0 : Math.round((c.count / total) * 100);
          return (
            <li key={c.text}>
              <div>
                {c.correct ? <strong className="pass">✓ </strong> : null}
                <TaskText text={c.text} /> <span className="muted small">{c.count} ({share}%)</span>
              </div>
              <div className="bar" role="presentation">
                <span className={c.correct ? 'bar-fill' : 'bar-fill bar-wrong'} style={{ width: `${share}%` }} />
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
