import { useEffect, useRef, useState } from 'react';
import { isLeaveDetectionPaused } from './useLeaveDetection';

// Tests that require full screen: the test is only shown while the browser
// fills the whole screen, which hides other windows and the taskbar.

/** False on browsers that can't go full screen (e.g. iPhone Safari): there it isn't enforced. */
export function fullscreenSupported(): boolean {
  return typeof document !== 'undefined' && document.fullscreenEnabled === true;
}

function isFullscreen(): boolean {
  return document.fullscreenElement !== null;
}

/** Must run inside a click (browsers only allow full screen in answer to the student). */
export function enterFullscreen(): Promise<void> {
  if (!fullscreenSupported() || isFullscreen()) return Promise.resolve();
  return document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => undefined);
}

export function exitFullscreen(): void {
  if (fullscreenSupported() && isFullscreen()) void document.exitFullscreen().catch(() => undefined);
}

/**
 * While `active`: whether the page is in full screen, and a report each time
 * the student leaves full screen (Esc, F11, the browser's own button).
 */
export function useFullscreenGate(active: boolean, onExited: () => void): { inFullscreen: boolean } {
  const [inFullscreen, setInFullscreen] = useState(() => !fullscreenSupported() || isFullscreen());
  const onExitedRef = useRef(onExited);
  onExitedRef.current = onExited;

  useEffect(() => {
    if (!fullscreenSupported()) return;
    const onChange = () => {
      const now = isFullscreen();
      setInFullscreen(now);
      if (!now && active && !isLeaveDetectionPaused()) onExitedRef.current();
    };
    setInFullscreen(isFullscreen());
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, [active]);

  return { inFullscreen: inFullscreen || !fullscreenSupported() };
}
