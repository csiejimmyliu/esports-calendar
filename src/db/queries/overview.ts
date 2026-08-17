/**
 * The overview read (SPEC §2 FR-2).
 *
 * Everything else in this directory was written for sync's *write* path. This is the first query
 * that exists to be shown to a person, and it is the only one whose result is the `Match` domain
 * shape from `src/core/types.ts` rather than a row-ish struct.
 *
 * Two decisions are load-bearing and are stated here because a later reader will be tempted to
 * undo both:
 *
 * 1. **Keyset paging, never OFFSET.** Sync inserts and cancels matches underneath a user who is
 *    scrolling. With OFFSET, a row inserted above the current position silently shifts the window
 *    and the user either skips a match or sees one twice. A cursor on `(starts_at_utc, id)` is
 *    immune: it names a position in the ordering, not a count. `id` breaks ties because two
 *    matches routinely start at the same instant.
 * 2. **No system clock is read here.** The caller supplies `anchor`. The repo's fixtures are
 *    frozen at their capture date, so a query that consulted `Date.now()` would return nothing
 *    against them for a reason that has nothing to do with the code — the same rule CLAUDE.md
 *    already imposes on every fixture-backed test and on `src/cli/next-matches.ts --now`.
 */

import type { PoolClient } from 'pg';

import type { GameSlug, Match, MatchState } from '../../core/types.js';

export interface OverviewCursor {
  startsAtUtc: string;
  id: string;
}

export interface OverviewQuery {
  /** Which title. Passed in rather than joined out, so a match with no resolved league still has one. */
  game: GameSlug;
  /**
   * ISO instant bounding the first page. Required — see decision 2 above.
   *
   * `forward` from the anchor is FR-2's default view: matches at or after it, **plus every match
   * currently in progress**, which by definition started before it. That is not an option flag,
   * it is what "in progress and future" means.
   */
  anchor: string;
  /** `forward` = later in time (the default view); `backward` = the user scrolling up into the past. */
  direction: 'forward' | 'backward';
  /** Exclusive keyset boundary. Absent on the first page, where `anchor` bounds it instead. */
  cursor?: OverviewCursor;
  limit: number;
  /** Canonical league ids. Absent means no league filter. A filter is view state and issues no write (FR-2). */
  leagueIds?: readonly string[];
  /** Canonical team ids. A match matches if either side is one of them. */
  teamIds?: readonly string[];
}

export interface OverviewPage {
  /** Always in the order the query produced: ascending for `forward`, descending for `backward`. */
  matches: Match[];
  /** Feed back as `cursor` for the next page in the same direction. Null when the page was not full. */
  nextCursor: OverviewCursor | null;
}

interface MatchRowShape {
  id: string;
  tournament_id: string | null;
  league_id: string | null;
  starts_at_utc: Date;
  best_of: number | null;
  games_played: number;
  block_name: string | null;
  state: MatchState;
  revision: number;
}

/** Matches `src/db/queries/matches.ts`, which normalises the same way. Postgres hands back a Date. */
function toIsoInstant(value: Date | string): string {
  return new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export async function listOverviewMatches(client: PoolClient, query: OverviewQuery): Promise<OverviewPage> {
  const params: unknown[] = [query.game];
  const where: string[] = [
    // The game dimension lives on external_ref, not on `match`: it is the one per-match record of
    // which title a match belongs to that does not depend on the league having resolved
    // (SourceMatch.leagueExternalId is legitimately null under degradation). EXISTS rather than a
    // join so a match with refs from two sources cannot multiply into two rows.
    `EXISTS (
       SELECT 1 FROM external_ref er JOIN game g ON g.id = er.game_id
       WHERE er.entity_type = 'match' AND er.entity_id = m.id AND g.slug = $1
     )`,
  ];

  const ascending = query.direction === 'forward';

  // Eligibility and position are separate conditions, and both apply on *every* page. Making the
  // cursor an `else` branch would drop the eligibility rule from page two onward: a forward page
  // filled entirely with in-progress matches leaves a cursor still earlier than the anchor, and
  // the next page would then admit rows that are neither in progress nor in the future.
  params.push(query.anchor);
  where.push(
    ascending
      ? `(m.starts_at_utc >= $${params.length} OR m.state = 'inProgress')`
      : `m.starts_at_utc < $${params.length}`,
  );

  if (query.cursor !== undefined) {
    params.push(query.cursor.startsAtUtc, query.cursor.id);
    const comparison = ascending ? '>' : '<';
    where.push(`(m.starts_at_utc, m.id) ${comparison} ($${params.length - 1}, $${params.length})`);
  }

  if (query.leagueIds !== undefined) {
    params.push(query.leagueIds);
    where.push(`m.league_id = ANY($${params.length}::text[])`);
  }

  if (query.teamIds !== undefined) {
    params.push(query.teamIds);
    where.push(
      `EXISTS (SELECT 1 FROM match_team mt WHERE mt.match_id = m.id AND mt.team_id = ANY($${params.length}::text[]))`,
    );
  }

  params.push(query.limit);
  const order = ascending ? 'ASC' : 'DESC';

  const { rows } = await client.query<MatchRowShape>(
    `SELECT m.id, m.tournament_id, m.league_id, m.starts_at_utc, m.best_of,
            m.games_played, m.block_name, m.state, m.revision
     FROM match m
     WHERE ${where.join(' AND ')}
     ORDER BY m.starts_at_utc ${order}, m.id ${order}
     LIMIT $${params.length}`,
    params,
  );

  const sidesByMatch = await loadSides(
    client,
    rows.map((r) => r.id),
    query.game,
  );

  const matches = rows.map<Match>((row) => ({
    id: row.id,
    game: query.game,
    leagueId: row.league_id,
    tournamentId: row.tournament_id,
    startsAtUtc: toIsoInstant(row.starts_at_utc),
    state: row.state,
    seriesLength: row.best_of,
    gamesPlayed: row.games_played,
    sides: sidesByMatch.get(row.id) ?? [
      { team: null, score: null },
      { team: null, score: null },
    ],
    stageLabel: row.block_name,
    // Riot declares `capabilities.streamUrls: false` and the `stream` table is unwritten (SPEC §4,
    // FR-4). Null rather than a lookup that would always miss; FR-4's ladder is a later stage.
    streamUrl: null,
    revision: row.revision,
  }));

  const last = rows[rows.length - 1];
  const nextCursor =
    rows.length === query.limit && last !== undefined
      ? { startsAtUtc: toIsoInstant(last.starts_at_utc), id: last.id }
      : null;

  return { matches, nextCursor };
}

/**
 * Sides for a page of matches, in one round trip.
 *
 * A separate query rather than a join onto the main one: joining `match_team` would return two
 * rows per match and make `LIMIT` count sides instead of matches — the classic way a paged query
 * with a to-many join returns half a page.
 *
 * `team_id IS NULL` is TBD and stays a `null` team, which is what makes FR-1 rule 7 work: the
 * match is already here, it simply has nobody on that side yet.
 */
async function loadSides(
  client: PoolClient,
  matchIds: readonly string[],
  game: GameSlug,
): Promise<Map<string, Match['sides']>> {
  const bySide = new Map<string, Match['sides']>();
  if (matchIds.length === 0) return bySide;

  const { rows } = await client.query<{
    match_id: string;
    side_index: number;
    score: number | null;
    team_id: string | null;
    team_name: string | null;
    team_code: string | null;
    team_image_url: string | null;
  }>(
    `SELECT mt.match_id, mt.side_index, mt.score,
            t.id AS team_id, t.name AS team_name, t.code AS team_code, t.image_url AS team_image_url
     FROM match_team mt
     LEFT JOIN team t ON t.id = mt.team_id
     WHERE mt.match_id = ANY($1::text[])`,
    [matchIds],
  );

  for (const row of rows) {
    const sides =
      bySide.get(row.match_id) ??
      ([
        { team: null, score: null },
        { team: null, score: null },
      ] as Match['sides']);

    sides[row.side_index === 0 ? 0 : 1] = {
      team:
        row.team_id === null || row.team_name === null
          ? null
          : {
              id: row.team_id,
              game,
              name: row.team_name,
              code: row.team_code,
              logoUrl: row.team_image_url,
            },
      score: row.score,
    };
    bySide.set(row.match_id, sides);
  }

  return bySide;
}
