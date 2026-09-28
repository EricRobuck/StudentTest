import { useCallback, useState } from 'react';

// Remembers which question the student is on across page refreshes, per
// session. A convenience only: Phase 7 moves progress to the server.

function storageKey(sessionId: string): string {
  return `linuxlab.question.${sessionId}`;
}

function load(sessionId: string, count: number): number {
  try {
    const value = Number(sessionStorage.getItem(storageKey(sessionId)));
    return Number.isInteger(value) && value >= 0 && value < count ? value : 0;
  } catch {
    return 0;
  }
}

export function useCurrentQuestion(sessionId: string, count: number) {
  const [index, setIndex] = useState(() => load(sessionId, count));

  const goTo = useCallback(
    (next: number) => {
      const clamped = Math.max(0, Math.min(count - 1, next));
      setIndex(clamped);
      try {
        sessionStorage.setItem(storageKey(sessionId), String(clamped));
      } catch {
        // Storage unavailable (private mode etc.): navigation still works.
      }
    },
    [sessionId, count],
  );

  return { index, goTo };
}
