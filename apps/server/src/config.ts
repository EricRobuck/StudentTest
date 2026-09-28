// Central configuration. Every environment variable the server reads is
// parsed here and nowhere else, so misconfiguration fails fast at startup.

import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Optional <repo>/.env file (git-ignored) for local settings such as
// INSTRUCTOR_PASSWORD. Real environment variables take precedence.
try {
  process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
} catch {
  // No .env file: fine.
}

function readPort(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535 (got "${raw}")`);
  }
  return port;
}

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer (got "${raw}")`);
  }
  return value;
}

function readList(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

const webUrl = process.env.WEB_URL || 'http://127.0.0.1:5173';

function readInstructorPassword(): string | undefined {
  const value = process.env.INSTRUCTOR_PASSWORD;
  if (!value) return undefined; // instructor pages disabled
  if (value.length < 10) throw new Error('INSTRUCTOR_PASSWORD must be at least 10 characters');
  return value;
}

const databasePath =
  process.env.DATABASE_PATH || fileURLToPath(new URL('../../../data/linuxlab.sqlite', import.meta.url));

// Identifies this backend's containers on a shared Docker host. Defaults to a
// hash of the database path: containers belong to the database that tracks them.
const instanceId =
  process.env.LINUXLAB_INSTANCE || createHash('sha256').update(databasePath).digest('hex').slice(0, 12);

export const config = {
  serviceName: 'linux-lab-server',
  version: '0.1.0',
  port: readPort('PORT', 3001),
  // Bind to loopback by default. The backend holds access to the Docker
  // daemon (root-equivalent on the host), so it must never be exposed on a
  // network interface by accident.
  host: process.env.HOST || '127.0.0.1',
  // Where students open the app. In development this is the Vite dev server.
  webUrl,

  security: {
    // Browser origins allowed to open terminals and change state. Requests
    // from any other site are refused (blocks cross-site WebSocket hijacking).
    allowedOrigins: [
      ...new Set(readList('ALLOWED_ORIGINS', [webUrl, 'http://localhost:5173', 'http://127.0.0.1:5173'])),
    ],
    // Cookies are sent over HTTPS only when the site is served over HTTPS
    // (automatic when WEB_URL is https://; COOKIE_SECURE=true/false overrides).
    cookieSecure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : webUrl.startsWith('https://'),
    // Shared instructor password (interim until instructor accounts exist).
    // Unset = instructor pages disabled. There is deliberately no default.
    instructorPassword: readInstructorPassword(),

    rateLimits: {
      // New exam sessions (each creates a container) per client address per
      // 10 minutes. A whole classroom behind one school NAT shares an
      // address, so keep this above the class size. Resuming never counts.
      newSessionsPerAddress: readPositiveInt('NEW_SESSIONS_PER_IP', 60),
      // Submit clicks per session per minute (each runs checks in the container).
      submitsPerSessionPerMinute: 20,
      // Other state-changing requests per session per minute.
      writesPerSessionPerMinute: 120,
      // Command-log entries: burst size, then this many per second; hard cap per attempt.
      commandLogBurst: 40,
      commandLogPerSecond: 5,
      commandLogMaxPerAttempt: 5000,
    },
  },

  // SQLite file. Default: <repo>/data/linuxlab.sqlite (git-ignored).
  databasePath,

  // 'practice' (default) or 'exam': which settings the sample exam runs with.
  sampleExamMode: process.env.SAMPLE_EXAM_MODE === 'exam' ? ('exam' as const) : ('practice' as const),

  sessions: {
    // A session with no browser attached for this long has its container
    // removed (a new one is created if the student comes back). Refreshes
    // and brief disconnects are well within it.
    idleTimeoutMinutes: readPositiveInt('SESSION_IDLE_TIMEOUT_MINUTES', 30),
    // Also how often expired exam timers are enforced.
    sweepIntervalSeconds: 30,
  },

  terminal: {
    // Recent output kept per session and replayed after a refresh/reconnect.
    replayBufferBytes: 128 * 1024,
    // Pause the shell when the browser falls this far behind (output floods).
    maxBufferedBytes: 1024 * 1024,
    heartbeatSeconds: 30,
  },

  containers: {
    image: process.env.CONTAINER_IMAGE || 'linuxlab/student-ubuntu:24.04',
    instanceId,
    memoryBytes: 256 * 1024 * 1024,
    nanoCpus: 500_000_000, // 0.5 CPU
    pidsLimit: 128,
    tmpSizeMb: 64,
    homeSizeMb: 64,
    maxFileSizeBytes: 50 * 1024 * 1024,
    maxOpenFiles: 1024,
    maxConcurrent: 50,
    // Hard cap on how long any student container may exist.
    maxLifetimeMinutes: readPositiveInt('CONTAINER_MAX_LIFETIME_MINUTES', 180),
    reapIntervalSeconds: 60,
    // Unowned containers younger than this are left alone (still being set up).
    orphanGraceSeconds: 120,
  },
} as const;

export type ContainerConfig = typeof config.containers;
