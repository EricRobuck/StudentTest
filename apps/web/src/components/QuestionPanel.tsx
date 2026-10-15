import { useState } from 'react';
import type { QuestionProgress, StudentQuestion, SubmitFeedback, SubmitResult } from '@linuxlab/shared';
import { TaskText } from './TaskText';

interface QuestionPanelProps {
  question: StudentQuestion;
  total: number;
  progress: QuestionProgress | undefined;
  /** The latest submission made from this page, if any. */
  lastSubmit: SubmitResult | undefined;
  submitting: boolean;
  submitError: string | null;
  onSubmit: () => void;
  onPrevious: () => void;
  onNext: () => void;
}

export function QuestionPanel({
  question,
  total,
  progress,
  lastSubmit,
  submitting,
  submitError,
  onSubmit,
  onPrevious,
  onNext,
}: QuestionPanelProps) {
  const [hintShownFor, setHintShownFor] = useState<string | null>(null);
  const hintShown = hintShownFor === question.id;
  const isFirst = question.number === 1;
  const isLast = question.number === total;
  const attempts = progress?.attempts ?? 0;
  // A correct answer (when results are shown) closes the question: trying again can't earn more.
  const passed = progress?.best?.passed === true || lastSubmit?.feedback?.passed === true;
  const locked = (progress?.locked ?? false) || passed;
  const missed = !passed && progress?.attemptsRemaining === 0;

  let submitLabel = attempts > 0 ? 'Check again' : 'Submit answer';
  if (submitting) submitLabel = 'Checking…';
  else if (passed) submitLabel = '✓ Correct';
  else if (missed) submitLabel = 'Missed';
  else if (locked) submitLabel = 'Submitted';

  return (
    <div className="question">
      <div className="question-meta">
        <span>
          Question {question.number} of {total}
        </span>
        <span className="points">{question.points} points</span>
      </div>

      <h2>{question.title}</h2>
      <p className="question-tags muted">
        {question.category} · {question.difficulty}
      </p>

      <p className="question-text">
        <TaskText text={question.text} />
      </p>
      {question.instructions && (
        <p className="question-instructions">
          <TaskText text={question.instructions} />
        </p>
      )}

      {question.hint &&
        (hintShown ? (
          <p className="hint">
            <strong>Hint:</strong> <TaskText text={question.hint} />
          </p>
        ) : (
          <button type="button" className="link-button" onClick={() => setHintShownFor(question.id)}>
            Show hint
          </button>
        ))}

      {lastSubmit?.feedback && <FeedbackBox feedback={lastSubmit.feedback} />}
      {lastSubmit && !lastSubmit.feedback && (
        <p className="result result-recorded" role="status">
          Answer recorded (attempt {lastSubmit.attemptNumber}). Results are shown when the exam ends.
        </p>
      )}
      {!lastSubmit && progress?.best && (
        <p className={`result ${progress.best.passed ? 'result-pass' : progress.best.partial ? 'result-partial' : 'result-fail'}`}>
          {progress.best.passed ? 'Best so far: ✓ Correct' : progress.best.partial ? 'Partial credit' : 'Best so far: ✗ Not yet'} —{' '}
          {progress.best.pointsAwarded}/{question.points} points
        </p>
      )}
      {submitError && (
        <p className="result result-error" role="alert">
          {submitError}
        </p>
      )}

      <div className="question-actions">
        <button type="button" className="secondary" onClick={onPrevious} disabled={isFirst}>
          ← Previous
        </button>
        <button type="button" onClick={onSubmit} disabled={submitting || locked}>
          {submitLabel}
        </button>
        <button type="button" className="secondary" onClick={onNext} disabled={isLast}>
          Next →
        </button>
      </div>
      {missed && (progress?.best || lastSubmit?.feedback) && (
        <p className="result result-fail" role="status">
          <strong>✗ Missed</strong>: no tries left on this question.
          {(progress?.best?.partial || lastSubmit?.feedback?.partial) && ' You got partial credit for the parts you got right.'}
        </p>
      )}
      {!passed && !missed && progress?.attemptsRemaining !== null && progress?.attemptsRemaining !== undefined && (
        <p className="attempts-left muted">
          {progress.attemptsRemaining} {progress.attemptsRemaining === 1 ? 'try' : 'tries'} left
          {progress.nextTryPoints !== null && (
            <>
              {' '}
              · a correct answer now earns <strong>{progress.nextTryPoints}</strong> of {question.points} points
            </>
          )}
        </p>
      )}
    </div>
  );
}

function FeedbackBox({ feedback }: { feedback: SubmitFeedback }) {
  const label = feedback.passed ? '✓ Correct' : feedback.partial ? '✗ Not quite: partial credit' : '✗ Not yet';
  return (
    <div className={`result ${feedback.passed ? 'result-pass' : feedback.partial ? 'result-partial' : 'result-fail'}`} role="status">
      <strong>
        {label} — {feedback.pointsAwarded}/{feedback.maxPoints} points
      </strong>
      {/* Only technical problems (e.g. terminal not connected) are listed; reasons that would give away the answer are never sent. */}
      {feedback.rules.length > 0 && (
        <ul>
          {feedback.rules.map((rule, i) => (
            <li key={i}>{rule.message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
