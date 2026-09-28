import { useEffect, useRef, useState } from 'react';

interface ExamTimerProps {
  /** null = untimed exam. */
  deadlineAt: string | null;
  clockOffsetMs: number;
  onExpired: () => void;
}

const WARNING_MS = 5 * 60_000;

/**
 * Counts down to the server-side deadline. Display only: the server enforces
 * the deadline no matter what this shows.
 */
export function ExamTimer({ deadlineAt, clockOffsetMs, onExpired }: ExamTimerProps) {
  const [now, setNow] = useState(() => Date.now());
  const expiredFired = useRef(false);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const remaining = deadlineAt === null ? null : Date.parse(deadlineAt) - (now + clockOffsetMs);

  useEffect(() => {
    if (remaining !== null && remaining <= 0 && !expiredFired.current) {
      expiredFired.current = true;
      onExpired();
    }
  }, [remaining, onExpired]);

  if (remaining === null) {
    return (
      <div className="exam-meta">
        <span className="muted">Time</span>
        <span className="timer">Untimed</span>
      </div>
    );
  }

  return (
    <div className="exam-meta">
      <span className="muted">Time remaining</span>
      <span className={`timer ${remaining < WARNING_MS ? 'timer-warning' : ''}`} role="timer">
        {formatDuration(Math.max(0, remaining))}
      </span>
    </div>
  );
}

function formatDuration(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
