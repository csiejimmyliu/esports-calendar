/**
 * Anonymous identity issuance (SPEC §2 FR-1).
 *
 * One endpoint, and it is the only response in the API that ever contains a token. Everything
 * else takes one in a header and returns none.
 */

import { Router } from 'express';
import type { Pool } from 'pg';

import { createAnonymousUser } from '../../db/queries/users.js';

export function createIdentityRouter(pool: Pool): Router {
  const router = Router();

  /**
   * Creates an `app_user` with `email IS NULL` and its first token.
   *
   * Unauthenticated by necessity — this is where a client with nothing gets something. That makes
   * it the one endpoint an unthrottled caller can use to create rows, which is a real gap and is
   * named rather than hidden: rate limiting is not in stage 2b (see the plan's "deliberately NOT
   * built"), and a row costs one uuid and one token. The mitigation belongs at the edge, with the
   * rest of stage 9's infrastructure, not in an `if` here.
   *
   * The write is a transaction so a failure between the two inserts cannot leave a user row that
   * no token addresses.
   */
  router.post('/anon-users', async (_req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const user = await createAnonymousUser(client);
      await client.query('COMMIT');
      res.status(201).json(user);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  return router;
}
