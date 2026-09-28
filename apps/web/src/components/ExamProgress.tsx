import type { StudentQuestion } from '@linuxlab/shared';

interface ExamProgressProps {
  questions: StudentQuestion[];
  currentIndex: number;
  onSelect: (index: number) => void;
}

/** One step per question; click to jump. Phase 6/7 add passed/failed states. */
export function ExamProgress({ questions, currentIndex, onSelect }: ExamProgressProps) {
  return (
    <nav className="exam-progress" aria-label="Exam progress">
      <ol>
        {questions.map((q, i) => (
          <li key={q.id}>
            <button
              type="button"
              className={i === currentIndex ? 'progress-step current' : 'progress-step'}
              aria-current={i === currentIndex ? 'step' : undefined}
              title={`Question ${q.number}: ${q.title}`}
              onClick={() => onSelect(i)}
            >
              {q.number}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}
