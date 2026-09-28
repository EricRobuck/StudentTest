// Display helpers for instructor pages.

export function formatDateTime(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : '—';
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour12: false });
}

export function formatSeconds(total: number): string {
  if (total < 60) return `${total}s`;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m ${String(s).padStart(2, '0')}s`;
}

/**
 * Student-controlled text (commands, file contents) may contain terminal
 * control characters. Show them as visible symbols instead of raw bytes.
 * (React already escapes HTML, so this is about readability, not XSS.)
 */
export function printable(text: string): string {
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, (c) => (c === '\x1b' ? '␛' : `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`));
}
