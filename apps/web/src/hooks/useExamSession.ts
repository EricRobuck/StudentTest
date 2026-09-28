import { useCallback, useEffect, useState } from 'react';
import type { AttemptView, ExamResultView, StudentExam } from '@linuxlab/shared';
import { api } from '../api/client';

export type ExamSessionState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | {
      kind: 'in_progress';
      exam: StudentExam;
      attempt: AttemptView;
      /** server clock − browser clock, so the timer is right even if the PC clock is wrong. */
      clockOffsetMs: number;
      environmentReset: boolean;
    }
  | { kind: 'completed'; result: ExamResultView };

/**
 * Loads everything the exam screen needs, from the server (the source of
 * truth): the session, then either the exam + live attempt, or the final
 * result if the exam is already over.
 */
export function useExamSession() {
  const [state, setState] = useState<ExamSessionState>({ kind: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    (async () => {
      try {
        const session = await api.startSession();
        if (session.attemptStatus === 'completed') {
          const result = await api.result(signal);
          setState({ kind: 'completed', result });
          return;
        }
        const [exam, attempt] = await Promise.all([api.exam(signal), api.attempt(signal)]);
        if (attempt.status === 'completed') {
          setState({ kind: 'completed', result: await api.result(signal) });
          return;
        }
        setState({
          kind: 'in_progress',
          exam,
          attempt,
          clockOffsetMs: Date.parse(attempt.serverTime) - Date.now(),
          environmentReset: session.environmentReset,
        });
      } catch (err) {
        if (signal.aborted) return;
        setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => controller.abort();
  }, [reloadKey]);

  /** Re-fetch everything from the server (e.g. when the timer reaches zero). */
  const reload = useCallback(() => setReloadKey((n) => n + 1), []);

  /** Apply a change to the live attempt (after a submit or navigation). */
  const updateAttempt = useCallback((update: (attempt: AttemptView) => AttemptView) => {
    setState((s) => (s.kind === 'in_progress' ? { ...s, attempt: update(s.attempt) } : s));
  }, []);

  const showResult = useCallback((result: ExamResultView) => setState({ kind: 'completed', result }), []);

  return { state, reload, updateAttempt, showResult };
}
