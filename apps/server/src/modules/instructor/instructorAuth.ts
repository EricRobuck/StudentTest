import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// Interim instructor authentication: one shared password from the
// INSTRUCTOR_PASSWORD setting. Replaced by real accounts later; everything
// else (routes, pages) only depends on "is this request an instructor?".
//
// Sessions are kept in memory (instructors log in again after a server restart).

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

export type LoginOutcome = { ok: true; token: string } | { ok: false; reason: 'invalid' | 'rate-limited' | 'disabled' };

export class InstructorAuth {
  private readonly passwordHash: Buffer | null;
  private readonly sessions = new Map<string, number>(); // token hash → expiry
  private readonly failures = new Map<string, { count: number; since: number }>(); // per client address

  constructor(password: string | undefined) {
    this.passwordHash = password ? sha256(password) : null;
  }

  get enabled(): boolean {
    return this.passwordHash !== null;
  }

  login(password: string, clientAddress: string): LoginOutcome {
    if (!this.passwordHash) return { ok: false, reason: 'disabled' };

    const now = Date.now();
    const f = this.failures.get(clientAddress);
    if (f && now - f.since < LOCKOUT_MS && f.count >= MAX_FAILURES) {
      console.warn(`[audit] instructor login blocked (too many failures) from ${clientAddress}`);
      return { ok: false, reason: 'rate-limited' };
    }

    // Compare fixed-length hashes in constant time.
    if (!timingSafeEqual(sha256(password), this.passwordHash)) {
      const fresh = !f || now - f.since >= LOCKOUT_MS;
      this.failures.set(clientAddress, { count: fresh ? 1 : f.count + 1, since: fresh ? now : f.since });
      console.warn(`[audit] instructor login FAILED from ${clientAddress}`);
      return { ok: false, reason: 'invalid' };
    }

    this.failures.delete(clientAddress);
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(sha256(token).toString('hex'), now + SESSION_TTL_MS);
    console.log(`[audit] instructor login from ${clientAddress}`);
    return { ok: true, token };
  }

  isValid(token: string | undefined): boolean {
    if (!token || !this.enabled) return false;
    const key = sha256(token).toString('hex');
    const expiry = this.sessions.get(key);
    if (expiry === undefined) return false;
    if (expiry < Date.now()) {
      this.sessions.delete(key);
      return false;
    }
    return true;
  }

  logout(token: string | undefined): void {
    if (token) this.sessions.delete(sha256(token).toString('hex'));
  }
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}
