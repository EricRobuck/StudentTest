import { useCallback, useState } from 'react';
import type { AttemptView, ExamResultView, StudentExam, SubmitResult } from '@linuxlab/shared';
import { api } from './api/client';
import { BackendStatus } from './components/BackendStatus';
import { ExamProgress } from './components/ExamProgress';
import { ExamTimer } from './components/ExamTimer';
import { LockedScreen } from './components/LockedScreen';
import { QuestionPanel } from './components/QuestionPanel';
import { ResultsView } from './components/ResultsView';
import { StartScreen } from './components/StartScreen';
import { useBackendHealth } from './hooks/useBackendHealth';
import { useExamSession } from './hooks/useExamSession';
import { useLeaveDetection, withLeaveDetectionPaused } from './hooks/useLeaveDetection';
import { TerminalView } from './terminal/TerminalView';
import { createWebSocketTransport } from './terminal/webSocketTransport';

// Student exam screen: question on the left, real Linux terminal on the right.
// All exam state (timer, progress, score) comes from the server.
export function App() {
  const health = useBackendHealth();
  const { state, reload, updateAttempt, showResult, chooseAnotherTest } = useExamSession();

  // Leaving the test screen locks the test (when the test uses that setting).
  const inProgress = state.kind === 'in_progress';
  const locked = inProgress && state.attempt.locked !== null;
  const markLocked = useCallback(
    () =>
      updateAttempt((a) =>
        a.locked ? a : { ...a, locked: { at: new Date().toISOString(), reason: 'left the test screen' } },
      ),
    [updateAttempt],
  );
  useLeaveDetection(inProgress && state.exam.rules.lockOnLeave && !locked, (reason, closing) => {
    if (!closing) markLocked(); // cover the screen right away; the server confirms below
    api
      .reportLeft(reason)
      .then((attempt) => updateAttempt(() => attempt))
      .catch(() => undefined);
  });
  const onLockChanged = useCallback(
    (attempt: AttemptView) => {
      if (attempt.status !== 'in_progress') reload();
      else updateAttempt(() => attempt);
    },
    [reload, updateAttempt],
  );
  const createTransport = useCallback(() => createWebSocketTransport({ onLocked: markLocked }), [markLocked]);

  return (
    <div className="exam-layout">
      <header className="exam-header">
        <div>
          <h1>{state.kind === 'in_progress' ? state.exam.title : 'Linux Practical Exam'}</h1>
          {state.kind === 'in_progress' && (
            <p className="muted">
              <strong className="student-name">{state.student.name}</strong> · {state.student.className} ·{' '}
              {state.exam.questions.length} questions · {state.exam.totalPoints} points · {state.exam.mode} mode
            </p>
          )}
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

      {state.kind === 'start' ? (
        <main className="exam-body exam-body-single">
          <StartScreen onStarted={reload} initial={state.initial} />
        </main>
      ) : state.kind === 'in_progress' && state.attempt.locked ? (
        <main className="exam-body exam-body-single">
          <LockedScreen studentName={state.student.name} onChanged={onLockChanged} />
        </main>
      ) : state.kind === 'completed' ? (
        <main className="exam-body exam-body-single">
          <ResultsView
            result={state.result}
            onStartOver={async () => {
              await api.newAttempt();
              reload();
            }}
            onTakeAnother={() =>
              chooseAnotherTest(
                state.result.studentName
                  ? { name: state.result.studentName, className: state.result.className ?? '' }
                  : undefined,
              )
            }
          />
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
            {state.kind === 'in_progress' && <TerminalView createTransport={createTransport} />}
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
      if (code === 'COMPLETED' || code === 'TEST_LOCKED') onExamOver(); // time ran out / locked: reload
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const finish = async () => {
    const unanswered = attempt.questions.filter((p) => p.attempts === 0).length;
    const warning = unanswered > 0 ? `\n\n${unanswered} question(s) have not been submitted.` : '';
    const confirmed = withLeaveDetectionPaused(() =>
      window.confirm(`Finish the exam now? You won't be able to change your answers.${warning}`),
    );
    if (!confirmed) return;
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
