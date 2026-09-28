import type { QuestionProgress, StudentQuestion } from '@linuxlab/shared';

interface ExamProgressProps {
  questions: StudentQuestion[];
  progress: QuestionProgress[];
  currentIndex: number;
  onSelect: (index: number) => void;
}

type StepState = 'passed' | 'failed' | 'answered' | 'unanswered';

function stepState(p: QuestionProgress | undefined): StepState {
  if (!p || p.attempts === 0) return 'unanswered';
  if (!p.best) return 'answered'; // submitted, result hidden until the end
  return p.best.passed ? 'passed' : 'failed';
}

const LABEL: Record<StepState, string> = {
  passed: 'correct',
  failed: 'not yet correct',
  answered: 'answer recorded',
  unanswered: 'not answered',
};

/** One step per question, colored by its best result; click to jump. */
export function ExamProgress({ questions, progress, currentIndex, onSelect }: ExamProgressProps) {
  return (
    <nav className="exam-progress" aria-label="Exam progress">
      <ol>
        {questions.map((q, i) => {
          const state = stepState(progress.find((p) => p.questionId === q.id));
          const classes = ['progress-step', state, i === currentIndex ? 'current' : ''].join(' ');
          return (
            <li key={q.id}>
              <button
                type="button"
                className={classes}
                aria-current={i === currentIndex ? 'step' : undefined}
                title={`Question ${q.number}: ${q.title} (${LABEL[state]})`}
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
