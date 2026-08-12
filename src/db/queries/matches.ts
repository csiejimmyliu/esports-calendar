import type { PoolClient } from 'pg';

import type { MatchState } from '../../core/types.js';

export interface MatchFields {
  tournamentId: string | null;
  leagueId: string | null;
  startsAtUtc: string;
  bestOf: number | null;
  gamesPlayed: number;
  blockName: string | null;
  state: MatchState;
}

export interface MatchRow extends MatchFields {
  id: string;
  revision: number;
}

export async function getMatchById(client: PoolClient, id: string): Promise<MatchRow | null> {
  const { rows } = await client.query<{
    id: string;
    tournament_id: string | null;
    league_id: string | null;
    starts_at_utc: string;
    best_of: number | null;
    games_played: number;
    block_name: string | null;
    state: MatchState;
    revision: number;
  }>(
    `SELECT id, tournament_id, league_id, starts_at_utc, best_of, games_played, block_name, state, revision
     FROM match WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    id: row.id,
    tournamentId: row.tournament_id,
    leagueId: row.league_id,
    startsAtUtc: new Date(row.starts_at_utc).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    bestOf: row.best_of,
    gamesPlayed: row.games_played,
    blockName: row.block_name,
    state: row.state,
    revision: row.revision,
  };
}

export async function insertMatch(client: PoolClient, fields: MatchFields): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO match (tournament_id, league_id, starts_at_utc, best_of, games_played, block_name, state, revision)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 1)
     RETURNING id`,
    [fields.tournamentId, fields.leagueId, fields.startsAtUtc, fields.bestOf, fields.gamesPlayed, fields.blockName, fields.state],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('insertMatch: INSERT ... RETURNING produced no row');
  return row.id;
}

/**
 * `bumpRevision` is the caller's decision (src/sync/diff.ts's `visibleChange`), never derived
 * here — this module has no opinion about which fields are user-visible.
 *
 * The `WHERE ... IS DISTINCT FROM` guard is what makes a second sync run over unchanged data a
 * genuine no-op rather than just "no duplicate rows": without it this UPDATE fires unconditionally
 * on every match, on every run, moving `updated_at` for a row whose content — including fields
 * `bumpRevision` does not cover, like a score update — did not actually change. A staleness or
 * incremental-sync consumer keyed on `updated_at` would otherwise see the whole table touched
 * hourly. Returns whether a row was actually written.
 */
export async function updateMatch(
  client: PoolClient,
  id: string,
  fields: MatchFields,
  bumpRevision: boolean,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `UPDATE match SET
       tournament_id = $2, league_id = $3, starts_at_utc = $4, best_of = $5,
       games_played = $6, block_name = $7, state = $8,
       revision = revision + $9, updated_at = now()
     WHERE id = $1
       AND (
         tournament_id IS DISTINCT FROM $2 OR
         league_id IS DISTINCT FROM $3 OR
         starts_at_utc IS DISTINCT FROM $4 OR
         best_of IS DISTINCT FROM $5 OR
         games_played IS DISTINCT FROM $6 OR
         block_name IS DISTINCT FROM $7 OR
         state IS DISTINCT FROM $8 OR
         $9 <> 0
       )`,
    [
      id,
      fields.tournamentId,
      fields.leagueId,
      fields.startsAtUtc,
      fields.bestOf,
      fields.gamesPlayed,
      fields.blockName,
      fields.state,
      bumpRevision ? 1 : 0,
    ],
  );
  return (rowCount ?? 0) > 0;
}

export async function upsertMatchTeam(
  client: PoolClient,
  matchId: string,
  sideIndex: 0 | 1,
  teamId: string | null,
  score: number | null,
): Promise<void> {
  await client.query(
    `INSERT INTO match_team (match_id, side_index, team_id, score)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (match_id, side_index) DO UPDATE SET team_id = EXCLUDED.team_id, score = EXCLUDED.score`,
    [matchId, sideIndex, teamId, score],
  );
}

/** Current resolved team id per side, positional (index 0 / 1), for diffing against an incoming fetch. */
export async function getMatchTeams(client: PoolClient, matchId: string): Promise<[string | null, string | null]> {
  const { rows } = await client.query<{ side_index: number; team_id: string | null }>(
    `SELECT side_index, team_id FROM match_team WHERE match_id = $1`,
    [matchId],
  );
  const bySide = new Map(rows.map((r) => [r.side_index, r.team_id]));
  return [bySide.get(0) ?? null, bySide.get(1) ?? null];
}

export interface KnownMatch {
  matchId: string;
  externalId: string;
  startsAtUtc: string;
  state: MatchState;
}

/**
 * Every match this source has previously ingested, for cancellation detection
 * (src/sync/cancellation.ts). Scoped to one source so a second source's matches are never
 * touched by this one's crawl horizon — NFR-3/NFR-4 apply to detection, not only to fetching.
 *
 * Not scoped to one *scope* within that source, though `syncScope` (src/sync/ingest.ts) calls it
 * per scope and derives the cancellation horizon from that scope's own fetch. `riot-rest-lol` has
 * exactly one implicit scope, so today the two coincide. A future multi-scope source (a per-
 * tournament source like BLAST) would let scope A's horizon cancel scope B's matches if they
 * share a date range — this is a known gap, not a verified-safe design, and needs a `scope_key`
 * on the crosswalk or a per-scope query before a second scope exists on any source.
 */
export async function listKnownMatches(client: PoolClient, sourceId: string, gameId: string): Promise<KnownMatch[]> {
  const { rows } = await client.query<{
    match_id: string;
    external_id: string;
    starts_at_utc: string;
    state: MatchState;
  }>(
    `SELECT er.entity_id AS match_id, er.external_id, m.starts_at_utc, m.state
     FROM external_ref er
     JOIN match m ON m.id = er.entity_id
     WHERE er.entity_type = 'match' AND er.source_id = $1 AND er.game_id = $2`,
    [sourceId, gameId],
  );
  return rows.map((r) => ({
    matchId: r.match_id,
    externalId: r.external_id,
    startsAtUtc: new Date(r.starts_at_utc).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    state: r.state,
  }));
}

/**
 * Idempotent: a match already cancelled does not bump revision again on a later run that still
 * does not see it. Returns whether this call actually cancelled the row — the caller's
 * `matchesCancelled` counter uses this so a re-run does not keep reporting the same cancellation.
 */
export async function markCancelled(client: PoolClient, matchId: string): Promise<boolean> {
  const { rowCount } = await client.query(
    `UPDATE match SET state = 'cancelled', revision = revision + 1, updated_at = now()
     WHERE id = $1 AND state <> 'cancelled'`,
    [matchId],
  );
  return (rowCount ?? 0) > 0;
}
