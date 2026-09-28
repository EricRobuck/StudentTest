// Central configuration. Every environment variable the server reads is
// parsed here and nowhere else, so misconfiguration fails fast at startup.

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
    // Set COOKIE_SECURE=true when served over HTTPS.
    cookieSecure: process.env.COOKIE_SECURE === 'true',
  },

  sessions: {
    // A session with no browser attached for this long is ended and its
    // container removed. Refreshes and brief disconnects are well within it.
    idleTimeoutMinutes: readPositiveInt('SESSION_IDLE_TIMEOUT_MINUTES', 30),
    sweepIntervalSeconds: 60,
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
    memoryBytes: 256 * 1024 * 1024,
    nanoCpus: 500_000_000, // 0.5 CPU
    pidsLimit: 128,
    tmpSizeMb: 64,
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
