import { useCallback, useEffect, useState } from 'react';
import type { InstructorStatus } from '@linuxlab/shared';
import { instructorApi } from '../api/client';
import { AttemptDetailPage } from './AttemptDetailPage';
import { AttemptsPage } from './AttemptsPage';
import { ExamEditorPage } from './ExamEditorPage';
import { ExamsPage } from './ExamsPage';
import { LoginPage } from './LoginPage';

// Instructor area at /instructor. Two pages: the attempts list and one
// attempt's detail (/instructor/attempts/<id>). A tiny history-based router
// keeps normal back/forward navigation working.

function usePath(): [string, (to: string) => void] {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const navigate = useCallback((to: string) => {
    window.history.pushState(null, '', to);
    setPath(to);
    window.scrollTo(0, 0);
  }, []);
  return [path, navigate];
}

export function InstructorApp() {
  const [path, navigate] = usePath();
  const [status, setStatus] = useState<InstructorStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = useCallback(() => {
    instructorApi
      .me()
      .then(setStatus)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);
  useEffect(refreshStatus, [refreshStatus]);

  const logout = async () => {
    await instructorApi.logout().catch(() => undefined);
    refreshStatus();
  };

  const attemptMatch = /^\/instructor\/attempts\/([0-9a-f-]{36})\/?$/.exec(path);
  const examMatch = /^\/instructor\/exams\/([A-Za-z0-9_-]{1,100})\/?$/.exec(path);
  const onExams = path.startsWith('/instructor/exams');

  const link = (to: string, label: string, current: boolean) => (
    <a
      href={to}
      className={current ? 'nav-link current' : 'nav-link'}
      aria-current={current ? 'page' : undefined}
      onClick={(e) => {
        e.preventDefault();
        navigate(to);
      }}
    >
      {label}
    </a>
  );

  let page;
  if (attemptMatch) page = <AttemptDetailPage attemptId={attemptMatch[1]!} onBack={() => navigate('/instructor')} />;
  else if (examMatch) page = <ExamEditorPage examId={examMatch[1]!} onBack={() => navigate('/instructor/exams')} />;
  else if (onExams) page = <ExamsPage onOpen={(id) => navigate(`/instructor/exams/${id}`)} />;
  else page = <AttemptsPage onOpen={(id) => navigate(`/instructor/attempts/${id}`)} />;

  return (
    <div className="instructor-layout">
      <header className="instructor-header">
        <h1>Linux Lab · Instructor</h1>
        {status?.authenticated && (
          <nav className="instructor-nav" aria-label="Instructor">
            {link('/instructor', 'Student attempts', !onExams)}
            {link('/instructor/exams', 'Exams', onExams)}
            <button type="button" className="secondary" onClick={() => void logout()}>
              Sign out
            </button>
          </nav>
        )}
      </header>
      <main className="instructor-main">
        {error && <p className="error-text">Could not reach the server: {error}</p>}
        {!status && !error && <p className="muted">Loading…</p>}
        {status && !status.enabled && (
          <p className="result result-error">
            Instructor access is not configured. Set <code>INSTRUCTOR_PASSWORD</code> (for example in the <code>.env</code>{' '}
            file) and restart the server.
          </p>
        )}
        {status?.enabled && !status.authenticated && <LoginPage onSignedIn={refreshStatus} />}
        {status?.authenticated && page}
      </main>
    </div>
  );
}
