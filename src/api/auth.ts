/**
 * Bearer-token authentication (SPEC §2 FR-1, CLAUDE.md's non-negotiable list).
 *
 * A header, not a cookie. A cookie is carried by the browser; NFR-1 forbids logic a native client
 * cannot reproduce, and stage 7 is the exam for that. This is also why there is no session: the
 * token is looked up per request against `user_token`, so any instance can serve any request
 * (NFR-6, and stage 9's ≥2 instances behind a load balancer).
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Pool } from 'pg';

import { findUserByToken } from '../db/queries/users.js';
import { ApiError } from './errors.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by `requireUser`. Absent on public routes — never read one without the middleware. */
      userId?: string;
    }
  }
}

const BEARER = /^Bearer (.+)$/;

/**
 * Requires a valid token, and fails identically however it fails.
 *
 * No header, a `Basic` header, a malformed value and a well-formed token nobody holds all produce
 * the same 401 body. That is SPEC §8's stage 2b criterion stated as behaviour: a caller must not
 * be able to use the response to learn whether a token exists, because the tokens are bearer
 * credentials with no rate limit above them and distinguishable failures make them enumerable.
 *
 * It `throw`s from an async middleware rather than calling `next(err)`. Express 5's documentation
 * states that rejected promises from async *route handlers* reach the error handler; that it also
 * holds for middleware is asserted by `tests/api/api.test.ts` — every 401 case in that file goes
 * through this throw, so the day it stops being true the suite hangs rather than passing quietly.
 *
 * There is deliberately no timing-safety claim here. `SELECT ... WHERE token = $1` on a primary
 * key is not constant-time, and pretending otherwise in a comment would be worse than saying so:
 * the defence is 32 bytes of entropy (`src/db/queries/users.ts`), not response symmetry.
 */
export function requireUser(pool: Pool): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const header = req.get('authorization');
    const matched = header === undefined ? null : BEARER.exec(header);
    if (matched === null) throw ApiError.unauthorized();

    const token = matched[1];
    if (token === undefined || token === '') throw ApiError.unauthorized();

    const client = await pool.connect();
    try {
      const userId = await findUserByToken(client, token);
      if (userId === null) throw ApiError.unauthorized();
      req.userId = userId;
    } finally {
      client.release();
    }
    next();
  };
}

/**
 * The user id the middleware resolved.
 *
 * Throws rather than returning undefined: reaching this on a route that forgot `requireUser` is a
 * programming error, and the loud version of it is a 500 in a test, not a query silently scoped to
 * `undefined`.
 */
export function userIdOf(req: Request): string {
  const { userId } = req;
  if (userId === undefined) {
    throw new Error('userIdOf called on a route without requireUser');
  }
  return userId;
}
