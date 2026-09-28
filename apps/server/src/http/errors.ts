import type { Response } from 'express';
import type { ApiError } from '@linuxlab/shared';

/** Sends the uniform { error: { code, message } } body. */
export function sendError(res: Response, status: number, code: string, message: string): void {
  const body: ApiError = { error: { code, message } };
  res.status(status).json(body);
}
