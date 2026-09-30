import { useCallback, useEffect, useState } from 'react';
import type { AttemptView, ExamResultView, StudentExam, StudentInfo } from '@linuxlab/shared';
import { api, ApiRequestError } from '../api/client';

export type ExamSessionState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  /** No session yet (or choosing another test): show the start screen. */
  | { kind: 'start'; initial?: StudentInfo }
  | {
      kind: 'in_progress';
      student: StudentInfo;
      exam: StudentExam;
      attempt: AttemptView;
      /** server clock − browser clock, so the timer is right even if the PC clock is wrong. */
      clockOffsetMs: number;
      environmentReset: boolean;
    }
  | { kind: 'completed'; result: ExamResultView };

/**
 * Loads everything the exam screen needs, from the server (the source of
 * truth): resume the session, then either the exam + live attempt, or the
 * final result if the exam is already over. No session → start screen.
 */
export function useExamSession() {
  const [state, setState] = useState<ExamSessionState>({ kind: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    (async () => {
      try {
        const session = await api.resumeSession();
        if (session.attemptStatus === 'in_progress' && !session.student.name) {
          // An exam that began before names were asked: ask now.
          setState({ kind: 'start' });
          return;
        }
        if (session.attemptStatus === 'completed') {
          setState({ kind: 'completed', result: await api.result(signal) });
          return;
        }
        const [exam, attempt] = await Promise.all([api.exam(signal), api.attempt(signal)]);
        if (attempt.status === 'completed') {
          setState({ kind: 'completed', result: await api.result(signal) });
          return;
        }
        setState({
          kind: 'in_progress',
          student: session.student,
          exam,
          attempt,
          clockOffsetMs: Date.parse(attempt.serverTime) - Date.now(),
          environmentReset: session.environmentReset,
        });
      } catch (err) {
        if (signal.aborted) return;
        if (err instanceof ApiRequestError && err.code === 'NO_SESSION') {
          setState({ kind: 'start' });
          return;
        }
        setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => controller.abort();
  }, [reloadKey]);

  /** Re-fetch everything from the server (e.g. after starting, or when the timer reaches zero). */
  const reload = useCallback(() => setReloadKey((n) => n + 1), []);

  /** Apply a change to the live attempt (after a submit or navigation). */
  const updateAttempt = useCallback((update: (attempt: AttemptView) => AttemptView) => {
    setState((s) => (s.kind === 'in_progress' ? { ...s, attempt: update(s.attempt) } : s));
  }, []);

  const showResult = useCallback((result: ExamResultView) => setState({ kind: 'completed', result }), []);

  /** From the results page: back to the start screen to choose another test. */
  const chooseAnotherTest = useCallback((initial?: StudentInfo) => setState({ kind: 'start', initial }), []);

  return { state, reload, updateAttempt, showResult, chooseAnotherTest };
}
