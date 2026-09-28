import { useCallback, useEffect, useState } from 'react';
import type { StudentExam } from '@linuxlab/shared';
import { api } from '../api/client';

export type ExamState =
  | { state: 'loading' }
  | { state: 'ready'; exam: StudentExam; sessionId: string }
  | { state: 'error'; message: string };

/** Makes sure this browser has a session (shared with the terminal), then loads the exam. */
export function useExam(): ExamState & { retry: () => void } {
  const [state, setState] = useState<ExamState>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState({ state: 'loading' });
    (async () => {
      try {
        const session = await api.startSession();
        const exam = await api.exam(controller.signal);
        setState({ state: 'ready', exam, sessionId: session.sessionId });
      } catch (err) {
        if (controller.signal.aborted) return;
        setState({ state: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => controller.abort();
  }, [attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...state, retry };
}
