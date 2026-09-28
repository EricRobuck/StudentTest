import { BackendStatus } from './components/BackendStatus';
import { useBackendHealth } from './hooks/useBackendHealth';
import { TerminalView } from './terminal/TerminalView';
import { createWebSocketTransport } from './terminal/webSocketTransport';

// Exam screen shell. The terminal is connected to real Bash in this
// student's container; exam data and grading arrive in later phases.
export function App() {
  const health = useBackendHealth();

  return (
    <div className="exam-layout">
      <header className="exam-header">
        <div>
          <h1>Linux Practical Exam</h1>
          <p className="muted">Student: (sign-in arrives in a later phase)</p>
        </div>
        <div className="exam-meta">
          <span className="muted">Time remaining</span>
          <span className="timer">--:--</span>
        </div>
      </header>

      <main className="exam-body">
        <section className="question-panel" aria-label="Question">
          <p className="muted">Question — of —</p>
          <h2>Questions load in Phase 5</h2>
          <p>
            This panel will show the question text, point value, and the Submit Answer and Next
            Question buttons.
          </p>
          <button type="button" disabled>
            Submit answer
          </button>
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
