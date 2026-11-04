import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { ACCOUNT_LIMITS, validateAccountFields, validatePassword, type InstructorAccountSummary, type InstructorMe } from '@linuxlab/shared';
import type { InstructorRecord, InstructorRepository } from '../db/index.js';
import type { ExamCatalog } from '../exams/examCatalog.js';

// Instructor accounts. Each professor signs in with a username and password
// and only ever reaches their own tests and attempts. Accounts are created by
// the administrator, never by signing up: the site is on the public internet.
//
// Passwords are stored as salted scrypt hashes. Sessions are kept in memory
// (instructors sign in again after a server restart).

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_FAILURES = 5;
/** Colleagues share a campus address, so the per-address limit is higher than per-account. */
const MAX_FAILURES_PER_ADDRESS = 25;
const LOCKOUT_MS = 15 * 60 * 1000;

/** The account created from INSTRUCTOR_PASSWORD on first start. */
export const FIRST_ADMIN_USERNAME = 'admin';

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

export type LoginOutcome = { ok: true; token: string } | { ok: false; reason: 'invalid' | 'rate-limited' | 'disabled' };

/** A rule was broken; the message is safe to show the instructor. */
export class AccountError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 429,
    message: string,
  ) {
    super(message);
  }
}

export class InstructorAuth {
  private readonly sessions = new Map<string, { instructorId: string; expiresAt: number }>(); // by token hash
  private readonly failures = new Map<string, { count: number; since: number }>();
  /** Hashed when a username doesn't exist, so sign-in takes as long and reveals nothing. */
  private readonly decoyHash = hashPassword(randomBytes(16).toString('hex'));
  private hasAccounts = false;
  private firstAdminId: string | undefined;

  constructor(
    private readonly repo: InstructorRepository,
    private readonly catalog: ExamCatalog,
  ) {}

  /**
   * Run at startup. On first start, INSTRUCTOR_PASSWORD becomes the
   * administrator's account. Tests and attempts without an owner (from before
   * accounts existed) belong to the administrator.
   */
  async bootstrap(initialPassword: string | undefined): Promise<void> {
    let accounts = await this.repo.list();
    if (accounts.length === 0 && initialPassword) {
      await this.repo.save({
        id: randomUUID(),
        username: FIRST_ADMIN_USERNAME,
        name: 'Instructor',
        passwordHash: await hashPassword(initialPassword),
        isAdmin: true,
        active: true,
        createdAt: new Date().toISOString(),
      });
      console.log(`[instructor] created the administrator account "${FIRST_ADMIN_USERNAME}"`);
      accounts = await this.repo.list();
    }
    this.hasAccounts = accounts.length > 0;
    this.firstAdminId = accounts.find((a) => a.isAdmin)?.id;
    if (this.firstAdminId) await this.repo.adoptOwnerless(this.firstAdminId);
  }

  get enabled(): boolean {
    return this.hasAccounts;
  }

  /** Owner of the sample exam on a brand-new database. */
  get adminId(): string | undefined {
    return this.firstAdminId;
  }

  async login(username: string, password: string, clientAddress: string): Promise<LoginOutcome> {
    if (!this.enabled) return { ok: false, reason: 'disabled' };
    const accountKey = `${clientAddress}|${username.toLowerCase()}`;
    if (this.isBlocked(accountKey, MAX_FAILURES) || this.isBlocked(clientAddress, MAX_FAILURES_PER_ADDRESS)) {
      console.warn(`[audit] instructor login blocked (too many failures) from ${clientAddress}`);
      return { ok: false, reason: 'rate-limited' };
    }
    const account = await this.repo.findByUsername(username);
    const matches = await verifyPassword(password, account?.passwordHash ?? (await this.decoyHash));
    if (!account || !account.active || !matches) {
      this.noteFailure(accountKey);
      this.noteFailure(clientAddress);
      console.warn(`[audit] instructor login FAILED from ${clientAddress} (username ${JSON.stringify(username.slice(0, 40))})`);
      return { ok: false, reason: 'invalid' };
    }
    this.failures.delete(accountKey);
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(sha256(token), { instructorId: account.id, expiresAt: Date.now() + SESSION_TTL_MS });
    console.log(`[audit] instructor ${account.username} signed in from ${clientAddress}`);
    return { ok: true, token };
  }

  /** The signed-in instructor. Reads the account each time, so disabling one takes effect at once. */
  async current(token: string | undefined): Promise<InstructorRecord | undefined> {
    if (!token) return undefined;
    const key = sha256(token);
    const session = this.sessions.get(key);
    if (!session) return undefined;
    if (session.expiresAt < Date.now()) {
      this.sessions.delete(key);
      return undefined;
    }
    const account = await this.repo.get(session.instructorId);
    return account?.active ? account : undefined;
  }

  logout(token: string | undefined): void {
    if (token) this.sessions.delete(sha256(token));
  }

  // ---------------------------------------------------------------- my account

  async updateMyAccount(me: InstructorRecord, body: unknown): Promise<InstructorMe> {
    const raw = asObject(body);
    const checked = validateAccountFields(raw.username, raw.name);
    if (!checked.ok) throw new AccountError(400, checked.errors.join(' '));
    await this.assertUsernameFree(checked.value.username, me.id);
    const next = { ...me, ...checked.value };
    await this.repo.save(next);
    console.log(`[audit] instructor ${me.username} updated their account (now ${next.username})`);
    return toMe(next);
  }

  async changeMyPassword(me: InstructorRecord, body: unknown, token: string | undefined, clientAddress: string): Promise<void> {
    const raw = asObject(body);
    const key = `${clientAddress}|${me.username.toLowerCase()}`;
    if (this.isBlocked(key, MAX_FAILURES)) throw new AccountError(429, 'Too many failed attempts. Try again in 15 minutes.');
    if (typeof raw.current !== 'string' || !(await verifyPassword(raw.current, me.passwordHash))) {
      this.noteFailure(key);
      throw new AccountError(400, 'Your current password is not correct.');
    }
    const problem = validatePassword(raw.next);
    if (problem) throw new AccountError(400, problem);
    await this.repo.save({ ...me, passwordHash: await hashPassword(raw.next as string) });
    this.endSessions(me.id, token);
    console.log(`[audit] instructor ${me.username} changed their password`);
  }

  // ---------------------------------------------------------- administrator only

  async listAccounts(): Promise<InstructorAccountSummary[]> {
    return (await this.repo.list()).map((a) => ({ ...toMe(a), active: a.active, testCount: this.catalog.countOwnedBy(a.id) }));
  }

  async createAccount(admin: InstructorRecord, body: unknown): Promise<InstructorAccountSummary> {
    const raw = asObject(body);
    const checked = validateAccountFields(raw.username, raw.name);
    if (!checked.ok) throw new AccountError(400, checked.errors.join(' '));
    const problem = validatePassword(raw.password);
    if (problem) throw new AccountError(400, problem);
    await this.assertUsernameFree(checked.value.username);
    const account: InstructorRecord = {
      id: randomUUID(),
      ...checked.value,
      passwordHash: await hashPassword(raw.password as string),
      isAdmin: false,
      active: true,
      createdAt: new Date().toISOString(),
    };
    await this.repo.save(account);
    this.hasAccounts = true;
    console.log(`[audit] ${admin.username} created the instructor account ${account.username}`);
    return { ...toMe(account), active: true, testCount: 0 };
  }

  async resetPassword(admin: InstructorRecord, id: string, body: unknown): Promise<void> {
    const account = await this.accountOrThrow(id);
    const password = asObject(body).password;
    const problem = validatePassword(password);
    if (problem) throw new AccountError(400, problem);
    await this.repo.save({ ...account, passwordHash: await hashPassword(password as string) });
    this.endSessions(id);
    console.log(`[audit] ${admin.username} reset the password of ${account.username}`);
  }

  /** Disabling closes the professor's tests to new students; their records are kept. */
  async setActive(admin: InstructorRecord, id: string, active: unknown): Promise<void> {
    if (typeof active !== 'boolean') throw new AccountError(400, 'active must be true or false.');
    const account = await this.accountOrThrow(id);
    if (account.id === admin.id && !active) throw new AccountError(409, "You can't disable your own account.");
    await this.repo.save({ ...account, active });
    if (!active) {
      this.endSessions(id);
      await this.catalog.closeTestsOf(id);
    }
    console.log(`[audit] ${admin.username} ${active ? 'enabled' : 'disabled'} the account ${account.username}`);
  }

  /** Professors' names by id, for the student start screen. */
  async professorNames(): Promise<Map<string, string>> {
    return new Map((await this.repo.list()).map((a) => [a.id, a.name]));
  }

  // ---------------------------------------------------------------- helpers

  private async accountOrThrow(id: string): Promise<InstructorRecord> {
    const account = await this.repo.get(id);
    if (!account) throw new AccountError(404, 'Account not found.');
    return account;
  }

  private async assertUsernameFree(username: string, exceptId?: string): Promise<void> {
    const other = await this.repo.findByUsername(username);
    if (other && other.id !== exceptId) throw new AccountError(409, `The username "${username}" is already taken.`);
  }

  private endSessions(instructorId: string, exceptToken?: string): void {
    const keep = exceptToken ? sha256(exceptToken) : undefined;
    for (const [key, s] of this.sessions) if (s.instructorId === instructorId && key !== keep) this.sessions.delete(key);
  }

  private isBlocked(key: string, limit: number): boolean {
    const f = this.failures.get(key);
    return Boolean(f && Date.now() - f.since < LOCKOUT_MS && f.count >= limit);
  }

  private noteFailure(key: string): void {
    const now = Date.now();
    const f = this.failures.get(key);
    const fresh = !f || now - f.since >= LOCKOUT_MS;
    this.failures.set(key, { count: fresh ? 1 : f.count + 1, since: fresh ? now : f.since });
  }
}

export function toMe(a: InstructorRecord): InstructorMe {
  return { id: a.id, username: a.username, name: a.name, isAdmin: a.isAdmin };
}

function asObject(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password.slice(0, ACCOUNT_LIMITS.passwordMax), salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [, saltHex, hashHex] = stored.split('$');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scryptAsync(password.slice(0, ACCOUNT_LIMITS.passwordMax), Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}
