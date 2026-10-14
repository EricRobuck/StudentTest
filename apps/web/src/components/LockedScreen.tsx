import { useEffect, useState, type RefObject } from 'react';
import type { AttemptView } from '@linuxlab/shared';
import { api, ApiRequestError } from '../api/client';

const POLL_MS = 3000;
/** Give the first report (sent when the student left) time to arrive before re-sending it. */
const FIRST_CHECK_MS = 2000;

interface LockedScreenProps {
  studentName: string;
  /** A leave report the server hasn't received yet; re-sent until it gets through. */
  pendingLeave: RefObject<string | null>;
  /** The instructor unlocked the test, the server never locked it, or the time ran out. */
  onChanged: (attempt: AttemptView) => void;
}

/** True when the server couldn't be reached at all (as opposed to answering with an error). */
function isConnectionProblem(err: unknown): boolean {
  return !(err instanceof ApiRequestError) || err.status >= 500;
}

/**
 * Shown after the student left the test screen, until the instructor unlocks
 * the test. If the server can't be reached, it says so instead: the test may
 * not be locked on the server yet, so the instructor would have nothing to unlock.
 */
export function LockedScreen({ studentName, pendingLeave, onChanged }: LockedScreenProps) {
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      try {
        const reason = pendingLeave.current;
        const attempt = reason ? await api.reportLeft(reason) : await api.attempt(controller.signal);
        if (reason) pendingLeave.current = null;
        setOffline(false);
        if (!attempt.locked || attempt.status !== 'in_progress') {
          onChanged(attempt);
          return;
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        if (isConnectionProblem(err)) setOffline(true);
      }
      timer = setTimeout(() => void check(), POLL_MS);
    };
    timer = setTimeout(() => void check(), FIRST_CHECK_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [onChanged, pendingLeave]);

  if (offline) {
    return (
      <div className="locked-screen offline-screen" role="alertdialog" aria-labelledby="offline-title">
        <div className="locked-card offline-card">
          <div className="locked-icon" aria-hidden="true">
            📶
          </div>
          <h2 id="offline-title">Lost connection to the test</h2>
          <p>
            <strong>{studentName}</strong>, your computer can't reach the test right now.
          </p>
          <p className="locked-call">Check that you're connected to the classroom Wi-Fi.</p>
          <p className="muted small">
            Reconnecting automatically… Your work so far is saved. If you left the test screen, the test locks when the
            connection is back, and you'll need to call your instructor.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="locked-screen" role="alertdialog" aria-labelledby="locked-title">
      <div className="locked-card">
        <div className="locked-icon" aria-hidden="true">
          🔒
        </div>
        <h2 id="locked-title">Test locked</h2>
        <p>
          <strong>{studentName}</strong>, you left the test screen, so your test has been locked.
        </p>
        <p className="locked-call">Raise your hand and call your instructor over.</p>
        <p className="muted small">
          Your work so far is saved. The timer keeps running. This page continues automatically once your instructor
          unlocks the test.
        </p>
      </div>
    </div>
  );
}
