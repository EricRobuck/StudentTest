import { useCallback, useEffect, useRef, useState } from 'react';
import type { AttemptView, ExamResultView, QuestionProgress, StudentExam, StudentQuestion } from '@linuxlab/shared';
import { api } from '../api/client';
import { withLeaveDetectionPaused } from '../hooks/useLeaveDetection';
import { ExamProgress } from './ExamProgress';
import { QuestionPanel } from './QuestionPanel';
import { TaskText } from './TaskText';

/** Typing is saved after this pause, so every key press isn't a request. */
const SAVE_DELAY_MS = 600;

interface WrittenExamProps {
  exam: StudentExam;
  attempt: AttemptView;
  updateAttempt: (update: (a: AttemptView) => AttemptView) => void;
  onFinished: (result: ExamResultView) => void;
  onExamOver: () => void;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/**
 * A written test: the question on the left (same place as a Linux lab), and
 * where the terminal would be, a place to answer. Answers save on their own
 * and can be changed until the test ends.
 */
export function WrittenExam({ exam, attempt, updateAttempt, onFinished, onExamOver }: WrittenExamProps) {
  const initialIndex = Math.max(0, exam.questions.findIndex((q) => q.id === attempt.currentQuestionId));
  const [index, setIndex] = useState(initialIndex);
  const [answers, setAnswers] = useState<Record<string, string>>(attempt.answers ?? {});
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);

  // Answers waiting for the pause in typing, and saves run one at a time so an
  // older answer can never overwrite a newer one.
  const pending = useRef(new Map<string, string>());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const queue = useRef<Promise<boolean>>(Promise.resolve(true));

  const flush = useCallback((): Promise<boolean> => {
    clearTimeout(timer.current);
    const batch = [...pending.current];
    pending.current.clear();
    for (const [questionId, answer] of batch) {
      queue.current = queue.current.then(async (okSoFar) => {
        setSaveState('saving');
        try {
          const progress: QuestionProgress = await api.saveAnswer(questionId, answer);
          updateAttempt((a) => ({
            ...a,
            answers: { ...a.answers, [questionId]: answer },
            questions: a.questions.map((p) => (p.questionId === questionId ? progress : p)),
          }));
          setSaveState('saved');
          return okSoFar;
        } catch (err) {
          const code = (err as { code?: string }).code;
          if (code === 'COMPLETED' || code === 'TEST_LOCKED') onExamOver();
          setSaveState('error');
          return false;
        }
      });
    }
    return queue.current;
  }, [updateAttempt, onExamOver]);

  // Don't lose the last few letters when this screen goes away.
  useEffect(() => () => void flush(), [flush]);

  const question = exam.questions[index];
  if (!question) return null;

  const change = (value: string, immediately: boolean) => {
    setAnswers((prev) => ({ ...prev, [question.id]: value }));
    pending.current.set(question.id, value);
    setSaveState('saving');
    clearTimeout(timer.current);
    if (immediately) void flush();
    else timer.current = setTimeout(() => void flush(), SAVE_DELAY_MS);
  };

  const navigate = (next: number) => {
    const target = exam.questions[Math.max(0, Math.min(exam.questions.length - 1, next))];
    if (!target) return;
    void flush();
    setIndex(exam.questions.indexOf(target));
    void api.setCurrentQuestion(target.id).catch(() => undefined);
  };

  const finish = async () => {
    setError(null);
    if (!(await flush())) {
      setError('Your latest answer could not be saved. Check your connection and try again.');
      queue.current = Promise.resolve(true);
      return;
    }
    const unanswered = exam.questions.filter((q) => !answers[q.id]?.trim()).length;
    const warning = unanswered > 0 ? `\n\n${unanswered} question(s) have no answer.` : '';
    const confirmed = withLeaveDetectionPaused(() =>
      window.confirm(`Finish the test now? You won't be able to change your answers.${warning}`),
    );
    if (!confirmed) return;
    setFinishing(true);
    try {
      onFinished(await api.finish());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setFinishing(false);
    }
  };

  const answeredCount = exam.questions.filter((q) => answers[q.id]?.trim()).length;

  return (
    <>
      <section className="question-panel" aria-label="Question">
        <ExamProgress questions={exam.questions} progress={attempt.questions} currentIndex={index} onSelect={navigate} />
        <QuestionPanel
          question={question}
          total={exam.questions.length}
          progress={attempt.questions.find((p) => p.questionId === question.id)}
          lastSubmit={undefined}
          submitting={false}
          submitError={null}
          written
          onSubmit={() => undefined}
          onPrevious={() => navigate(index - 1)}
          onNext={() => navigate(index + 1)}
        />
        <div className="finish-row">
          <button type="button" className="danger" onClick={() => void finish()} disabled={finishing}>
            {finishing ? 'Finishing…' : 'Finish test'}
          </button>
        </div>
      </section>

      <section className="answer-panel" aria-label="Your answer">
        <div className="section-head">
          <h2>Your answer</h2>
          <SaveStatus state={saveState} />
        </div>
        <AnswerInput
          key={question.id}
          question={question}
          value={answers[question.id] ?? ''}
          onChange={change}
          onBlur={() => void flush()}
        />
        {error && (
          <p className="result result-error" role="alert">
            {error}
          </p>
        )}
        <p className="muted small answer-summary">
          {answeredCount} of {exam.questions.length} answered. You can change any answer until you finish. Your results
          appear when the test is over.
        </p>
      </section>
    </>
  );
}

function SaveStatus({ state }: { state: SaveState }) {
  switch (state) {
    case 'saving':
      return <span className="muted small">Saving…</span>;
    case 'saved':
      return <span className="pass small">✓ Saved</span>;
    case 'error':
      return (
        <span className="fail small" role="alert">
          Not saved: check your connection
        </span>
      );
    default:
      return null;
  }
}

function AnswerInput({
  question,
  value,
  onChange,
  onBlur,
}: {
  question: StudentQuestion;
  value: string;
  onChange: (value: string, immediately: boolean) => void;
  onBlur: () => void;
}) {
  const format = question.answerFormat;
  if (format?.type === 'multiple_choice') {
    return (
      <fieldset className="test-choice answer-choices">
        <legend className="sr-only">Choose one answer</legend>
        {format.choices.map((choice) => (
          <label key={choice.value} className={`test-option ${value === choice.value ? 'selected' : ''}`}>
            <input
              type="radio"
              name={`answer-${question.id}`}
              checked={value === choice.value}
              onChange={() => onChange(choice.value, true)}
            />
            <span>
              <TaskText text={choice.text} />
            </span>
          </label>
        ))}
        {value !== '' && (
          <button type="button" className="link-button" onClick={() => onChange('', true)}>
            Clear my answer
          </button>
        )}
      </fieldset>
    );
  }
  if (format?.type === 'short_answer') {
    return (
      <label className="answer-blank">
        Write your answer
        <textarea
          rows={10}
          maxLength={5000}
          spellCheck
          value={value}
          onChange={(e) => onChange(e.target.value, false)}
          onBlur={onBlur}
          autoFocus
        />
      </label>
    );
  }
  return (
    <label className="answer-blank">
      Type your answer
      <input
        type="text"
        autoComplete="off"
        spellCheck={false}
        maxLength={500}
        value={value}
        onChange={(e) => onChange(e.target.value, false)}
        onBlur={onBlur}
        autoFocus
      />
    </label>
  );
}
