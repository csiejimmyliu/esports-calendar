/**
 * The overview group (SPEC §2 FR-2): every covered match, filterable by league and by team.
 *
 * **Unauthenticated on purpose.** This is the shared payload of SPEC §6 — identical for every
 * user, which is the whole basis of the caching design in stage 9. Requiring a token to browse
 * would make it per-user for no gain, since nothing here depends on who is asking.
 *
 * **Every handler in this file is a read, and the routes are GET only.** That is FR-2's other
 * half: "a filter is a view state; a follow is stored data". There is no write path in this
 * module for a filter to accidentally take.
 */

import { Router } from 'express';
import type { Pool } from 'pg';

import { listLeagues } from '../../db/queries/leagues.js';
import { listOverviewMatches } from '../../db/queries/overview.js';
import type { OverviewQuery } from '../../db/queries/overview.js';
import { decodeCursor, encodeCursor, pageQuerySchema, parseOrThrow } from '../schemas.js';
import type { PageQuery } from '../schemas.js';

/**
 * LoL is the only title (SPEC §0), and there is no `?game=` parameter because there is no second
 * value to pass. The dimension stays in the *type* — adding a query parameter with one legal value
 * would be an abstraction with no second user.
 */
export const GAME = 'lol' as const;

/** Shared by `/v1/matches` and `/v1/me/calendar`, which page identically. */
export function toOverviewQuery(query: PageQuery): OverviewQuery {
  return {
    game: GAME,
    anchor: query.anchor,
    direction: query.direction,
    limit: query.limit,
    ...(query.cursor === undefined ? {} : { cursor: decodeCursor(query.cursor) }),
    ...(query.league === undefined ? {} : { leagueIds: query.league }),
    ...(query.team === undefined ? {} : { teamIds: query.team }),
  };
}

export function serializeCursor(cursor: { startsAtUtc: string; id: string } | null): string | null {
  return cursor === null ? null : encodeCursor(cursor);
}

export function createOverviewRouter(pool: Pool): Router {
  const router = Router();

  router.get('/matches', async (req, res) => {
    const query = parseOrThrow(pageQuerySchema, req.query);
    const client = await pool.connect();
    try {
      const page = await listOverviewMatches(client, toOverviewQuery(query));
      res.json({ matches: page.matches, nextCursor: serializeCursor(page.nextCursor) });
    } finally {
      client.release();
    }
  });

  /**
   * Not named in SPEC §8's stage 2b row. It is here because FR-2's league filter has no usable
   * client without it — a caller cannot filter by a canonical league id it has no way to learn —
   * and it is a plain read of a table that already exists.
   */
  router.get('/leagues', async (_req, res) => {
    const client = await pool.connect();
    try {
      res.json({ leagues: await listLeagues(client, GAME) });
    } finally {
      client.release();
    }
  });

  return router;
}
