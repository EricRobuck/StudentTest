import type { RequestHandler } from 'express';
import type { ApiError } from '@linuxlab/shared';

export const SESSION_COOKIE = 'linuxlab_session';

/**
 * True only for an Origin header on the allow-list. Browsers always send
 * Origin on WebSocket upgrades and POSTs, so a missing Origin means the
 * request did not come from our web app.
 */
export function isAllowedOrigin(origin: string | undefined, allowed: readonly string[]): boolean {
  return origin !== undefined && allowed.includes(origin);
}

/** Rejects state-changing requests that come from another website (CSRF). */
export function requireAllowedOrigin(allowed: readonly string[]): RequestHandler {
  return (req, res, next) => {
    if (isAllowedOrigin(req.headers.origin, allowed)) return next();
    const body: ApiError = { error: { code: 'FORBIDDEN_ORIGIN', message: 'Request origin not allowed' } };
    res.status(403).json(body);
  };
}

/** Minimal Cookie header parser; avoids a dependency for one cookie. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      const value = part.slice(eq + 1).trim();
      return value === '' ? undefined : value;
    }
  }
  return undefined;
}
