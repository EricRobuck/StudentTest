import { useEffect, useRef } from 'react';

/** How long the window may lose focus before it counts as leaving (covers brief focus flickers). */
const BLUR_GRACE_MS = 1000;

let pausedUntil = 0;

/**
 * Runs `fn` (e.g. window.confirm) without it counting as leaving the test:
 * browser dialogs take focus away from the page.
 */
export function withLeaveDetectionPaused<T>(fn: () => T): T {
  pausedUntil = Number.POSITIVE_INFINITY;
  try {
    return fn();
  } finally {
    pausedUntil = Date.now() + BLUR_GRACE_MS + 500;
  }
}

/**
 * While `active`, calls `onLeft(reason)` when the student leaves the test
 * screen: switches tabs, minimizes the browser, switches to another window
 * or app, or closes/refreshes the page. The server decides what happens
 * (it locks the test); this hook only reports.
 */
export function useLeaveDetection(active: boolean, onLeft: (reason: string, closing: boolean) => void): void {
  const onLeftRef = useRef(onLeft);
  onLeftRef.current = onLeft;

  useEffect(() => {
    if (!active) return;
    let blurTimer: ReturnType<typeof setTimeout> | undefined;
    let reported = false;
    const report = (reason: string, closing = false) => {
      if (reported || Date.now() < pausedUntil) return;
      reported = true;
      onLeftRef.current(reason, closing);
    };

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') report('switched tabs or minimized the browser');
    };
    const onBlur = () => {
      clearTimeout(blurTimer);
      blurTimer = setTimeout(() => {
        if (!document.hasFocus()) report('switched to another window or app');
      }, BLUR_GRACE_MS);
    };
    const onFocus = () => clearTimeout(blurTimer);
    const onPageHide = () => report('closed or refreshed the test page', true);

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      clearTimeout(blurTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [active]);
}
