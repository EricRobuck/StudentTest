import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { config } from '../config.js';
import { sendError } from '../http/errors.js';
import { clientAddress } from '../http/rateLimit.js';
import { INSTRUCTOR_COOKIE, instructorOf, requireInstructor } from '../http/requireInstructor.js';
import { readCookie, requireAllowedOrigin } from '../http/security.js';
import { AccountError, type InstructorAuth } from '../modules/instructor/instructorAuth.js';

const ACCOUNT_ID = /^[0-9a-f-]{36}$/;

/** A professor's own account, and (administrator only) everyone's accounts. */
export function accountsRouter(auth: InstructorAuth): Router {
  const router = Router();
  const signedIn = [requireAllowedOrigin(config.security.allowedOrigins), requireInstructor(auth)];
  const adminOnly: RequestHandler = (_req, res, next) => {
    if (instructorOf(res).isAdmin) return next();
    sendError(res, 403, 'ADMIN_ONLY', 'Only the administrator can manage professors.');
  };

  const handle =
    (fn: (req: Request, res: Response) => Promise<unknown>, status = 200) =>
    async (req: Request, res: Response, next: NextFunction) => {
      const id = req.params.id;
      if (id !== undefined && !ACCOUNT_ID.test(String(id))) return sendError(res, 400, 'BAD_REQUEST', 'Invalid id');
      try {
        const body = await fn(req, res);
        if (status === 204) res.status(204).end();
        else res.status(status).json(body);
      } catch (err) {
        if (err instanceof AccountError) return sendError(res, err.status, 'ACCOUNT', err.message);
        next(err);
      }
    };

  router.put('/instructor/account', ...signedIn, handle((req, res) => auth.updateMyAccount(instructorOf(res), req.body)));
  router.post(
    '/instructor/account/password',
    ...signedIn,
    handle(
      (req, res) => auth.changeMyPassword(instructorOf(res), req.body, readCookie(req.headers.cookie, INSTRUCTOR_COOKIE), clientAddress(req)),
      204,
    ),
  );

  router.get('/instructor/accounts', requireInstructor(auth), adminOnly, handle(() => auth.listAccounts()));
  router.post('/instructor/accounts', ...signedIn, adminOnly, handle((req, res) => auth.createAccount(instructorOf(res), req.body), 201));
  router.post(
    '/instructor/accounts/:id/password',
    ...signedIn,
    adminOnly,
    handle((req, res) => auth.resetPassword(instructorOf(res), String(req.params.id), req.body), 204),
  );
  router.post(
    '/instructor/accounts/:id/active',
    ...signedIn,
    adminOnly,
    handle((req, res) => auth.setActive(instructorOf(res), String(req.params.id), (req.body as { active?: unknown } | undefined)?.active), 204),
  );

  return router;
}
