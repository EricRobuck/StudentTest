import { useState } from 'react';
import type { AttemptView, ExamResultView, StudentExam, SubmitResult } from '@linuxlab/shared';
import { api } from './api/client';
import { BackendStatus } from './components/BackendStatus';
import { ExamProgress } from './components/ExamProgress';
import { ExamTimer } from './components/ExamTimer';
import { QuestionPanel } from './components/QuestionPanel';
import { ResultsView } from './components/ResultsView';
import { useBackendHealth } from './hooks/useBackendHealth';
import { useExamSession } from './hooks/useExamSession';
import { TerminalView } from './terminal/TerminalView';
import { createWebSocketTransport } from './terminal/webSocketTransport';

// Student exam screen: question on the left, real Linux terminal on the right.
// All exam state (timer, progress, score) comes from the server.
export function App() {
  const health = useBackendHealth();
  const { state, reload, updateAttempt, showResult } = useExamSession();

  return (
    <div className="exam-layout">
      <header className="exam-header">
        <div>
          <h1>{state.kind === 'in_progress' ? state.exam.title : 'Linux Practical Exam'}</h1>
          <p className="muted">
            {state.kind === 'in_progress'
              ? `${state.exam.questions.length} questions · ${state.exam.totalPoints} points · ${state.exam.mode} mode`
              : 'Student: (sign-in arrives in a later phase)'}
          </p>
        </div>
        {state.kind === 'in_progress' && (
          <div className="header-right">
            {state.attempt.score && (
              <div className="exam-meta">
                <span className="muted">Score</span>
                <span className="timer">
                  {state.attempt.score.earned} / {state.attempt.score.max}
                </span>
              </div>
            )}
            <ExamTimer deadlineAt={state.attempt.deadlineAt} clockOffsetMs={state.clockOffsetMs} onExpired={reload} />
          </div>
        )}
      </header>

      {state.kind === 'completed' ? (
        <main className="exam-body exam-body-single">
          <ResultsView result={state.result} />
        </main>
      ) : (
        <main className="exam-body">
          <section className="question-panel" aria-label="Question">
            {state.kind === 'loading' && <p className="muted">Loading exam…</p>}
            {state.kind === 'error' && (
              <div>
                <p className="error-text">Could not load the exam: {state.message}</p>
                <button type="button" onClick={reload}>
                  Try again
                </button>
              </div>
            )}
            {state.kind === 'in_progress' && (
              <>
                {state.environmentReset && (
                  <p className="result result-error">
                    Your previous Linux environment had ended, so a fresh one was created. Files from before are
                    gone; points you already earned are kept.
                  </p>
                )}
                <QuestionArea
                  exam={state.exam}
                  attempt={state.attempt}
                  updateAttempt={updateAttempt}
                  onFinished={showResult}
                  onExamOver={reload}
                />
              </>
            )}
          </section>

          <section className="terminal-panel" aria-label="Linux terminal">
            {state.kind === 'in_progress' && <TerminalView createTransport={createWebSocketTransport} />}
          </section>
        </main>
      )}

      <footer className="exam-footer">
        <BackendStatus health={health} />
      </footer>
    </div>
  );
}

interface QuestionAreaProps {
  exam: StudentExam;
  attempt: AttemptView;
  updateAttempt: (update: (a: AttemptView) => AttemptView) => void;
  onFinished: (result: ExamResultView) => void;
  onExamOver: () => void;
}

function QuestionArea({ exam, attempt, updateAttempt, onFinished, onExamOver }: QuestionAreaProps) {
  const initialIndex = Math.max(0, exam.questions.findIndex((q) => q.id === attempt.currentQuestionId));
  const [index, setIndex] = useState(initialIndex);
  // Latest submission per question made from this page (for showing feedback).
  const [lastSubmits, setLastSubmits] = useState<Record<string, SubmitResult>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);

  const question = exam.questions[index];
  if (!question) return null;

  const navigate = (next: number) => {
    const target = exam.questions[Math.max(0, Math.min(exam.questions.length - 1, next))];
    if (!target) return;
    setSubmitError(null);
    setIndex(exam.questions.indexOf(target));
    // Remember the position server-side so a refresh or another device resumes here.
    void api.setCurrentQuestion(target.id).catch(() => undefined);
  };

  const submit = async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await api.submit(question.id);
      setLastSubmits((prev) => ({ ...prev, [result.questionId]: result }));
      updateAttempt((a) => ({
        ...a,
        score: result.score,
        questions: a.questions.map((p) => (p.questionId === result.questionId ? result.progress : p)),
      }));
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'COMPLETED') onExamOver(); // time ran out: go to results
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const finish = async () => {
    const unanswered = attempt.questions.filter((p) => p.attempts === 0).length;
    const warning = unanswered > 0 ? `\n\n${unanswered} question(s) have not been submitted.` : '';
    if (!window.confirm(`Finish the exam now? You won't be able to change your answers.${warning}`)) return;
    setFinishing(true);
    try {
      onFinished(await api.finish());
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
      setFinishing(false);
    }
  };

  return (
    <>
      <ExamProgress questions={exam.questions} progress={attempt.questions} currentIndex={index} onSelect={navigate} />
      <QuestionPanel
        question={question}
        total={exam.questions.length}
        progress={attempt.questions.find((p) => p.questionId === question.id)}
        lastSubmit={lastSubmits[question.id]}
        submitting={submitting}
        submitError={submitError}
        onSubmit={() => void submit()}
        onPrevious={() => navigate(index - 1)}
        onNext={() => navigate(index + 1)}
      />
      <div className="finish-row">
        <button type="button" className="danger" onClick={() => void finish()} disabled={finishing}>
          {finishing ? 'Finishing…' : 'Finish exam'}
        </button>
      </div>
    </>
  );
}
