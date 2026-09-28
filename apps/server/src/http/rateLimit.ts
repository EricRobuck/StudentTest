import type { Request, RequestHandler, Response } from 'express';
import { sendError } from './errors.js';

/**
 * Fixed-window counter per key (client address, session id, …). In memory:
 * fine for one server process; a shared store is needed if the backend is
 * ever scaled out to several processes.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
  ) {
    // Forget old windows so the map can't grow without bound.
    setInterval(() => {
      const now = Date.now();
      for (const [key, w] of this.windows) if (w.resetAt <= now) this.windows.delete(key);
    }, windowMs).unref();
  }

  /** Counts one hit. Returns 0 if allowed, otherwise seconds until the key may retry. */
  hit(key: string): number {
    const now = Date.now();
    const w = this.windows.get(key);
    if (!w || w.resetAt <= now) {
      this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
      return 0;
    }
    w.count++;
    return w.count > this.limit ? Math.ceil((w.resetAt - now) / 1000) : 0;
  }
}

export function sendRateLimited(res: Response, retryAfterSeconds: number, message: string): void {
  res.setHeader('Retry-After', String(retryAfterSeconds));
  sendError(res, 429, 'RATE_LIMITED', message);
}

/** Middleware form: limits requests by whatever key `keyOf` returns. */
export function rateLimit(limiter: RateLimiter, keyOf: (req: Request, res: Response) => string, message: string): RequestHandler {
  return (req, res, next) => {
    const retryAfter = limiter.hit(keyOf(req, res));
    if (retryAfter > 0) return sendRateLimited(res, retryAfter, message);
    next();
  };
}

export interface Limiters {
  /** New sessions (= new containers) per client address. */
  newSessions: RateLimiter;
  submits: RateLimiter;
  writes: RateLimiter;
}

export function createLimiters(cfg: {
  newSessionsPerAddress: number;
  submitsPerSessionPerMinute: number;
  writesPerSessionPerMinute: number;
}): Limiters {
  return {
    newSessions: new RateLimiter(cfg.newSessionsPerAddress, 10 * 60_000),
    submits: new RateLimiter(cfg.submitsPerSessionPerMinute, 60_000),
    writes: new RateLimiter(cfg.writesPerSessionPerMinute, 60_000),
  };
}

/** The client's address as seen by this server (see SECURITY.md about reverse proxies). */
export function clientAddress(req: Request): string {
  return req.socket.remoteAddress ?? 'unknown';
}
