import { useCallback, useEffect, useState } from 'react';
import type { InstructorStatus } from '@linuxlab/shared';
import { instructorApi } from '../api/client';
import { AttemptDetailPage } from './AttemptDetailPage';
import { AttemptsPage } from './AttemptsPage';
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

  return (
    <div className="instructor-layout">
      <header className="instructor-header">
        <a
          href="/instructor"
          onClick={(e) => {
            e.preventDefault();
            navigate('/instructor');
          }}
        >
          <h1>Linux Lab · Instructor</h1>
        </a>
        {status?.authenticated && (
          <button type="button" className="secondary" onClick={() => void logout()}>
            Sign out
          </button>
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
        {status?.authenticated &&
          (attemptMatch ? (
            <AttemptDetailPage attemptId={attemptMatch[1]!} onBack={() => navigate('/instructor')} />
          ) : (
            <AttemptsPage onOpen={(id) => navigate(`/instructor/attempts/${id}`)} />
          ))}
      </main>
    </div>
  );
}
