import type { RequestHandler } from 'express';

/**
 * Headers for every backend response. The backend only serves JSON (and a
 * redirect), so it can use the strictest settings: nothing may load, frame,
 * or cache these responses.
 */
export const securityHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  // Exam data, scores and instructor views must never be cached by browsers or proxies.
  res.setHeader('Cache-Control', 'no-store');
  next();
};
