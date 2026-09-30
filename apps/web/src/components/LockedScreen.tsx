import { useEffect } from 'react';
import type { AttemptView } from '@linuxlab/shared';
import { api } from '../api/client';

const POLL_MS = 3000;

interface LockedScreenProps {
  studentName: string;
  /** The instructor unlocked the test (or the time ran out). */
  onChanged: (attempt: AttemptView) => void;
}

/** Shown after the student left the test screen, until the instructor unlocks the test. */
export function LockedScreen({ studentName, onChanged }: LockedScreenProps) {
  useEffect(() => {
    const controller = new AbortController();
    const timer = setInterval(() => {
      api
        .attempt(controller.signal)
        .then((attempt) => {
          if (!attempt.locked || attempt.status !== 'in_progress') onChanged(attempt);
        })
        .catch(() => undefined);
    }, POLL_MS);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [onChanged]);

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
