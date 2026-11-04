import type { RequestHandler, Response } from 'express';
import type { InstructorRecord } from '../modules/db/index.js';
import type { InstructorAuth } from '../modules/instructor/instructorAuth.js';
import { sendError } from './errors.js';
import { readCookie } from './security.js';

export const INSTRUCTOR_COOKIE = 'linuxlab_instructor';

/**
 * Only signed-in instructors get past this; students' session cookies don't
 * count. Routes then read who it is with instructorOf(res).
 */
export function requireInstructor(auth: InstructorAuth): RequestHandler {
  return async (req, res, next) => {
    try {
      const instructor = await auth.current(readCookie(req.headers.cookie, INSTRUCTOR_COOKIE));
      if (!instructor) return sendError(res, 401, 'INSTRUCTOR_AUTH_REQUIRED', 'Instructor sign-in required');
      res.locals.instructor = instructor;
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function instructorOf(res: Response): InstructorRecord {
  return res.locals.instructor as InstructorRecord;
}
