import type { StudentQuestion, SubmitResult } from '@linuxlab/shared';

interface ExamProgressProps {
  questions: StudentQuestion[];
  currentIndex: number;
  results: Readonly<Record<string, SubmitResult>>;
  onSelect: (index: number) => void;
}

/** One step per question, colored by its latest result; click to jump. */
export function ExamProgress({ questions, currentIndex, results, onSelect }: ExamProgressProps) {
  return (
    <nav className="exam-progress" aria-label="Exam progress">
      <ol>
        {questions.map((q, i) => {
          const result = results[q.id];
          const state = result ? (result.passed ? 'passed' : 'failed') : 'unanswered';
          const classes = ['progress-step', state, i === currentIndex ? 'current' : ''].join(' ');
          return (
            <li key={q.id}>
              <button
                type="button"
                className={classes}
                aria-current={i === currentIndex ? 'step' : undefined}
                title={`Question ${q.number}: ${q.title} (${state})`}
                onClick={() => onSelect(i)}
              >
                {q.number}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
