import type { RequestHandler } from 'express';
import type { InstructorAuth } from '../modules/instructor/instructorAuth.js';
import { sendError } from './errors.js';
import { readCookie } from './security.js';

export const INSTRUCTOR_COOKIE = 'linuxlab_instructor';

/** Only authenticated instructors get past this; students' session cookies don't count. */
export function requireInstructor(auth: InstructorAuth): RequestHandler {
  return (req, res, next) => {
    if (auth.isValid(readCookie(req.headers.cookie, INSTRUCTOR_COOKIE))) return next();
    sendError(res, 401, 'INSTRUCTOR_AUTH_REQUIRED', 'Instructor sign-in required');
  };
}
