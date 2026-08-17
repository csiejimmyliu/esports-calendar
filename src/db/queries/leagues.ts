import type { PoolClient } from 'pg';

import type { LeagueKind, LeagueTier } from '../../config/leagues.js';

export interface LeagueFields {
  slug: string;
  name: string;
  region: string | null;
  logoUrl: string | null;
  /** Ours to maintain (SPEC §5) — computed from LeagueConfig at ingest time, not from the adapter. */
  tier: LeagueTier;
  kind: LeagueKind | null;
}

/**
 * `ON CONFLICT (game_id, slug)` rather than a plain INSERT: `league` has `UNIQUE (game_id, slug)`,
 * and `resolveOrCreate` (src/sync/crosswalk.ts) only calls this when the *external id* is new —
 * a second external id for the same slug (a reissued upstream league id, or the per-match fallback
 * in ingest.ts racing a later `fetchLeagues`) is exactly that case. Before Stage 1b that raised a
 * unique-violation and aborted the whole transaction; now it resolves to the pre-existing row, and
 * `resolveOrCreate` links the new external id onto it as a second crosswalk entry.
 */
export interface LeagueRow {
  id: string;
  slug: string;
  name: string;
  region: string | null;
  logoUrl: string | null;
  tier: LeagueTier;
  kind: LeagueKind | null;
}

/**
 * The covered leagues, for the overview's league filter (FR-2).
 *
 * `tier <> 'minor'` rather than `tier = 'major'`: `unclassified` means a league appeared upstream
 * after `config/leagues.json` was last touched (SPEC §4), and hiding those would make a coverage
 * gap invisible in the one surface where it would be noticed. An explicit `minor` is a recorded
 * decision and is excluded; an absent one is news and is shown.
 */
export async function listLeagues(client: PoolClient, gameSlug: string): Promise<LeagueRow[]> {
  const { rows } = await client.query<{
    id: string;
    slug: string;
    name: string;
    region: string | null;
    image_url: string | null;
    tier: LeagueTier;
    kind: LeagueKind | null;
  }>(
    `SELECT l.id, l.slug, l.name, l.region, l.image_url, l.tier, l.kind
     FROM league l JOIN game g ON g.id = l.game_id
     WHERE g.slug = $1 AND l.tier <> 'minor'
     ORDER BY l.kind NULLS LAST, l.name`,
    [gameSlug],
  );
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    region: r.region,
    logoUrl: r.image_url,
    tier: r.tier,
    kind: r.kind,
  }));
}

export async function insertLeague(client: PoolClient, gameId: string, fields: LeagueFields): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO league (game_id, slug, name, region, image_url, tier, kind)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (game_id, slug) DO UPDATE SET
       name = EXCLUDED.name, region = EXCLUDED.region, image_url = EXCLUDED.image_url,
       tier = EXCLUDED.tier, kind = EXCLUDED.kind
     RETURNING id`,
    [gameId, fields.slug, fields.name, fields.region, fields.logoUrl, fields.tier, fields.kind],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('insertLeague: INSERT ... RETURNING produced no row');
  return row.id;
}

/**
 * Denormalized display/coverage fields refresh unconditionally on every sync — unlike `match`,
 * `league` carries no `revision` (SPEC §5 only bumps that for match, which is what drives ICS
 * SEQUENCE), so there is no visible-change gate to apply here.
 */
export async function updateLeagueFields(client: PoolClient, leagueId: string, fields: LeagueFields): Promise<void> {
  await client.query(
    `UPDATE league SET name = $2, region = $3, image_url = $4, tier = $5, kind = $6 WHERE id = $1`,
    [leagueId, fields.name, fields.region, fields.logoUrl, fields.tier, fields.kind],
  );
}
