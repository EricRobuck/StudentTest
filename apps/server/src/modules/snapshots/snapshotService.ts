import type { FsEntry, FsSnapshotView } from '@linuxlab/shared';
import type { ContainerRuntime } from '../containers/index.js';
import type { Repositories } from '../db/index.js';

// Captures the student's files when an exam ends, so instructors can see the
// final filesystem state after the container is gone (requirements §16).
// Both scripts are constants run with a fixed argv; nothing is interpolated.

const ROOTS = ['/tmp', '/home/student'];
const MAX_ENTRIES = 2000;
const MAX_FILES = 50;
const MAX_FILE_BYTES = 2048;

// type|mode|owner|group|size|symlink target|path — one entry per line.
const LIST_SCRIPT = `find ${ROOTS.join(' ')} -xdev -maxdepth 8 -mindepth 1 -name .cache -prune -o -printf '%y|%m|%u|%g|%s|%l|%p\\n' 2>/dev/null | head -n ${MAX_ENTRIES + 1}`;

// path<TAB>base64(first bytes) for small regular files, skipping hidden ones.
const CONTENT_SCRIPT = `find ${ROOTS.join(' ')} -xdev -maxdepth 8 -type f -size -${MAX_FILE_BYTES + 1}c ! -path '*/.*' -print0 2>/dev/null | head -z -n ${MAX_FILES} | while IFS= read -r -d '' f; do printf '%s\\t' "$f"; head -c ${MAX_FILE_BYTES} -- "$f" | base64 -w0; printf '\\n'; done`;

export class SnapshotService {
  constructor(
    private readonly runtime: ContainerRuntime,
    private readonly repos: Repositories,
  ) {}

  /** Takes and stores a snapshot. Never throws: a failed snapshot must not block ending the exam. */
  async capture(attemptId: string, sessionId: string, containerId: string): Promise<void> {
    try {
      const snapshot = await this.take(containerId);
      await this.repos.snapshots.save(attemptId, sessionId, snapshot.takenAt, snapshot);
      console.log(`[snapshots] saved ${snapshot.entries.length} entries for attempt ${attemptId}`);
    } catch (err) {
      console.warn(`[snapshots] could not snapshot attempt ${attemptId}:`, err);
    }
  }

  private async take(containerId: string): Promise<FsSnapshotView> {
    const takenAt = new Date().toISOString();
    const opts = { user: 'root' as const, timeoutMs: 15_000, maxOutputBytes: 1024 * 1024 };
    const listing = await this.runtime.exec(containerId, ['/bin/bash', '-c', LIST_SCRIPT], opts);
    const contents = await this.runtime.exec(containerId, ['/bin/bash', '-c', CONTENT_SCRIPT], opts);

    const lines = listing.stdout.split('\n').filter(Boolean);
    const entries = lines.slice(0, MAX_ENTRIES).flatMap(parseEntry);
    entries.sort((a, b) => a.path.localeCompare(b.path));

    const files = contents.stdout
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        const tab = line.lastIndexOf('\t');
        if (tab <= 0) return [];
        const bytes = Buffer.from(line.slice(tab + 1), 'base64');
        return [{ path: line.slice(0, tab), content: bytes.toString('utf8'), truncated: bytes.length >= MAX_FILE_BYTES }];
      });

    return { takenAt, roots: ROOTS, entries, files, truncated: lines.length > MAX_ENTRIES || listing.truncated };
  }
}

const TYPES: Record<string, FsEntry['type']> = { f: 'file', d: 'directory', l: 'symlink' };

function parseEntry(line: string): FsEntry[] {
  // The path is last and may itself contain '|'.
  const parts = line.split('|');
  if (parts.length < 7) return [];
  const [type, mode, owner, group, size, target] = parts as [string, string, string, string, string, string];
  const path = parts.slice(6).join('|');
  if (!/^[0-7]{1,4}$/.test(mode) || !path.startsWith('/')) return [];
  return [
    {
      type: TYPES[type] ?? 'other',
      mode,
      owner,
      group,
      size: Number(size) || 0,
      path,
      ...(type === 'l' ? { target } : {}),
    },
  ];
}
