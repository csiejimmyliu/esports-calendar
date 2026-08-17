/**
 * The my-calendar group (SPEC §2 FR-1). Every route here requires a bearer token.
 *
 * The division of labour is the point of the 2a/2b split: nothing in this file decides anything.
 * Membership is `composeCalendar` (src/core/calendar.ts), persistence is `src/db/queries/`, and
 * these handlers only translate HTTP into those calls. A rule that appeared here instead of there
 * would be a rule the pure-function tests cannot reach.
 */

import { Router } from 'express';
import type { Pool } from 'pg';

import { composeCalendar } from '../../core/calendar.js';
import { addFollow, listFollows, removeFollow } from '../../db/queries/follows.js';
import { listOverviewMatches } from '../../db/queries/overview.js';
import { clearSelection, listSelections, setSelection } from '../../db/queries/selections.js';
import { requireUser, userIdOf } from '../auth.js';
import {
  followBodySchema,
  followParamsSchema,
  pageQuerySchema,
  parseOrThrow,
  selectionBodySchema,
} from '../schemas.js';
import { serializeCursor, toOverviewQuery } from './overview.js';

export function createMeRouter(pool: Pool): Router {
  const router = Router();
  router.use(requireUser(pool));

  /** The token-validity probe. Returns the id, which grants nothing on its own — only the token does. */
  router.get('/', (req, res) => {
    res.json({ userId: userIdOf(req) });
  });

  // -------------------------------------------------------------------------
  // Follows
  // -------------------------------------------------------------------------

  router.get('/follows', async (req, res) => {
    const client = await pool.connect();
    try {
      res.json({ follows: await listFollows(client, userIdOf(req)) });
    } finally {
      client.release();
    }
  });

  router.post('/follows', async (req, res) => {
    const follow = parseOrThrow(followBodySchema, req.body);
    const client = await pool.connect();
    try {
      const created = await addFollow(client, userIdOf(req), follow);
      // 201 on a new row, 200 when it was already there. Following twice is a no-op rather than a
      // conflict — the user's intent is satisfied either way, and a 409 would make a client that
      // retries a dropped request look like it did something wrong.
      res.status(created ? 201 : 200).json({ follow });
    } finally {
      client.release();
    }
  });

  router.delete('/follows/:targetType/:targetId', async (req, res) => {
    const follow = parseOrThrow(followParamsSchema, req.params);
    const client = await pool.connect();
    try {
      // Deletes the standing rule only. FR-1 rule 3: hand-picked matches survive an unfollow, and
      // the mechanism is that this touches no `selection` row (src/db/queries/follows.ts).
      await removeFollow(client, userIdOf(req), follow);
      res.status(204).end();
    } finally {
      client.release();
    }
  });

  // -------------------------------------------------------------------------
  // Selections
  // -------------------------------------------------------------------------

  router.get('/selections', async (req, res) => {
    const client = await pool.connect();
    try {
      res.json({ selections: await listSelections(client, userIdOf(req)) });
    } finally {
      client.release();
    }
  });

  /**
   * Picks or drops one match. `PUT` because it is idempotent and the state is the whole resource.
   *
   * Dropping a match writes `excluded`; it does not DELETE. FR-1 rules 4 and 5 require that
   * statement to survive the match finishing and the follow being removed, so the two verbs mean
   * genuinely different things here and the DELETE below is not "undo this PUT".
   */
  router.put('/selections/:matchId', async (req, res) => {
    const { state } = parseOrThrow(selectionBodySchema, req.body);
    const matchId = req.params.matchId;
    const client = await pool.connect();
    try {
      await setSelection(client, userIdOf(req), { matchId, state });
      res.json({ selection: { matchId, state } });
    } finally {
      client.release();
    }
  });

  /** "Treat it as if I had said nothing" — returns the match to whatever the user's follows derive. */
  router.delete('/selections/:matchId', async (req, res) => {
    const client = await pool.connect();
    try {
      await clearSelection(client, userIdOf(req), req.params.matchId);
      res.status(204).end();
    } finally {
      client.release();
    }
  });

  // -------------------------------------------------------------------------
  // The calendar itself
  // -------------------------------------------------------------------------

  /**
   * `calendar(u) = { m | (derived ∨ included) ∧ ¬excluded }`, composed over one page of the
   * overview.
   *
   * Composing after paging rather than before is a real trade-off and is stated here so it is not
   * mistaken for an oversight: a page of 50 overview matches can yield fewer than 50 calendar
   * matches, so `nextCursor` advances by overview position, not by calendar position. That keeps
   * the cursor stable and the query cheap. The alternative — filtering in SQL against the user's
   * follows and selections — would give exact page sizes at the cost of moving FR-1's rules into
   * a query where the table-driven tests cannot reach them, which is precisely the split stage 2a
   * exists to protect.
   */
  router.get('/calendar', async (req, res) => {
    const query = parseOrThrow(pageQuerySchema, req.query);
    const client = await pool.connect();
    try {
      const userId = userIdOf(req);
      const page = await listOverviewMatches(client, toOverviewQuery(query));
      const matches = composeCalendar({
        follows: await listFollows(client, userId),
        selections: await listSelections(client, userId),
        matches: page.matches,
      });
      res.json({ matches, nextCursor: serializeCursor(page.nextCursor) });
    } finally {
      client.release();
    }
  });

  return router;
}
