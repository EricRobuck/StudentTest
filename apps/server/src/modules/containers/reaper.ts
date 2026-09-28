import type { ContainerRuntime } from './types.js';

export interface ReapOptions {
  /** Hard lifetime cap for any container. */
  maxAgeMs: number;
  /** Containers a live session still owns. */
  ownedContainerIds: () => Promise<Set<string>>;
  /**
   * Unowned containers younger than this are left alone, so a container that
   * is still being created and registered is never removed by mistake.
   */
  orphanGraceMs: number;
}

/**
 * Removes managed containers that are too old or that no session owns. This is
 * the safety net that guarantees no student environment outlives an exam,
 * even if the server crashed or a session was never closed.
 */
export async function reap(runtime: ContainerRuntime, opts: ReapOptions): Promise<number> {
  const containers = await runtime.listManaged();
  const owned = await opts.ownedContainerIds();
  const now = Date.now();
  let removed = 0;
  for (const c of containers) {
    const age = now - c.createdAt.getTime();
    const expired = age > opts.maxAgeMs;
    const orphaned = !owned.has(c.containerId) && age > opts.orphanGraceMs;
    if (expired || orphaned) {
      await runtime.destroy(c.containerId);
      console.log(`[containers] removed ${expired ? 'expired' : 'orphaned'} container ${c.name}`);
      removed++;
    }
  }
  return removed;
}

/** Runs reap now and then on an interval. Returns a stop function. */
export function startReaper(
  runtime: ContainerRuntime,
  opts: ReapOptions & { intervalMs: number },
): () => void {
  const run = () =>
    reap(runtime, opts).catch((err: unknown) => {
      // Docker may simply not be running yet; do not crash the server over it.
      console.warn('[containers] reaper skipped:', err instanceof Error ? err.message : err);
    });

  void run();
  const timer = setInterval(() => void run(), opts.intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
