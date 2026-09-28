import { useState } from 'react';
import type { StudentQuestion, SubmitResult } from '@linuxlab/shared';
import { TaskText } from './TaskText';

interface QuestionPanelProps {
  question: StudentQuestion;
  total: number;
  result: SubmitResult | undefined;
  submitting: boolean;
  submitError: string | null;
  onSubmit: () => void;
  onPrevious: () => void;
  onNext: () => void;
}

export function QuestionPanel({
  question,
  total,
  result,
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

      {result && <ResultBox result={result} />}
      {submitError && (
        <p className="result result-error" role="alert">
          {submitError}
        </p>
      )}

      <div className="question-actions">
        <button type="button" className="secondary" onClick={onPrevious} disabled={isFirst}>
          ← Previous
        </button>
        <button type="button" onClick={onSubmit} disabled={submitting}>
          {submitting ? 'Checking…' : result ? 'Check again' : 'Submit answer'}
        </button>
        <button type="button" className="secondary" onClick={onNext} disabled={isLast}>
          Next →
        </button>
      </div>
    </div>
  );
}

function ResultBox({ result }: { result: SubmitResult }) {
  return (
    <div className={`result ${result.passed ? 'result-pass' : 'result-fail'}`} role="status">
      <strong>
        {result.passed ? '✓ Correct' : '✗ Not yet'} — {result.pointsAwarded}/{result.maxPoints} points
      </strong>
      <ul>
        {result.rules.map((rule, i) => (
          <li key={i}>{rule.message}</li>
        ))}
      </ul>
    </div>
  );
}
