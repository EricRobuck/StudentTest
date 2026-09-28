import { useState } from 'react';
import type { StudentExam, SubmitResult } from '@linuxlab/shared';
import { api } from './api/client';
import { BackendStatus } from './components/BackendStatus';
import { ExamProgress } from './components/ExamProgress';
import { QuestionPanel } from './components/QuestionPanel';
import { useBackendHealth } from './hooks/useBackendHealth';
import { useCurrentQuestion } from './hooks/useCurrentQuestion';
import { useExam } from './hooks/useExam';
import { TerminalView } from './terminal/TerminalView';
import { createWebSocketTransport } from './terminal/webSocketTransport';

// Student exam screen: question on the left, real Linux terminal on the right.
export function App() {
  const health = useBackendHealth();
  const exam = useExam();

  return (
    <div className="exam-layout">
      <header className="exam-header">
        <div>
          <h1>{exam.state === 'ready' ? exam.exam.title : 'Linux Practical Exam'}</h1>
          <p className="muted">
            {exam.state === 'ready'
              ? `${exam.exam.questions.length} questions · ${exam.exam.totalPoints} points · ${exam.exam.mode} mode`
              : 'Student: (sign-in arrives in a later phase)'}
          </p>
        </div>
        <div className="exam-meta">
          <span className="muted">Time remaining</span>
          <span className="timer">--:--</span>
        </div>
      </header>

      <main className="exam-body">
        <section className="question-panel" aria-label="Question">
          {exam.state === 'loading' && <p className="muted">Loading exam…</p>}
          {exam.state === 'error' && (
            <div>
              <p className="error-text">Could not load the exam: {exam.message}</p>
              <button type="button" onClick={exam.retry}>
                Try again
              </button>
            </div>
          )}
          {exam.state === 'ready' && <QuestionArea exam={exam.exam} sessionId={exam.sessionId} />}
        </section>

        <section className="terminal-panel" aria-label="Linux terminal">
          <TerminalView createTransport={createWebSocketTransport} />
        </section>
      </main>

      <footer className="exam-footer">
        <BackendStatus health={health} />
      </footer>
    </div>
  );
}

function QuestionArea({ exam, sessionId }: { exam: StudentExam; sessionId: string }) {
  const { index, goTo } = useCurrentQuestion(sessionId, exam.questions.length);
  // Latest result per question. Kept in the browser only until Phase 7 stores scores on the server.
  const [results, setResults] = useState<Record<string, SubmitResult>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const question = exam.questions[index];
  if (!question) return null;

  const navigate = (next: number) => {
    setSubmitError(null);
    goTo(next);
  };

  const submit = async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await api.submit(question.id);
      setResults((prev) => ({ ...prev, [result.questionId]: result }));
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <ExamProgress questions={exam.questions} currentIndex={index} results={results} onSelect={navigate} />
      <QuestionPanel
        question={question}
        total={exam.questions.length}
        result={results[question.id]}
        submitting={submitting}
        submitError={submitError}
        onSubmit={() => void submit()}
        onPrevious={() => navigate(index - 1)}
        onNext={() => navigate(index + 1)}
      />
    </>
  );
}
