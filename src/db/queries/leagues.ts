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

export async function insertLeague(client: PoolClient, gameId: string, fields: LeagueFields): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO league (game_id, slug, name, region, image_url, tier, kind)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
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
