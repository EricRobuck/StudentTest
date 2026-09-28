import { useEffect, useState } from 'react';
import type { HealthResponse } from '@linuxlab/shared';
import { api } from '../api/client';

export type BackendHealth =
  | { state: 'checking' }
  | { state: 'online'; info: HealthResponse }
  | { state: 'offline'; message: string };

const POLL_INTERVAL_MS = 10_000;

/** Polls GET /api/health so the UI can show whether the backend is reachable. */
export function useBackendHealth(): BackendHealth {
  const [health, setHealth] = useState<BackendHealth>({ state: 'checking' });

  useEffect(() => {
    let controller = new AbortController();

    const check = async () => {
      controller.abort();
      controller = new AbortController();
      try {
        const info = await api.health(controller.signal);
        setHealth({ state: 'online', info });
      } catch (err) {
        if (controller.signal.aborted) return;
        setHealth({ state: 'offline', message: err instanceof Error ? err.message : String(err) });
      }
    };

    void check();
    const timer = setInterval(() => void check(), POLL_INTERVAL_MS);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, []);

  return health;
}
