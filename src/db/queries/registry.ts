/**
 * Seeds `game` and `source` rows from src/sync/registry.ts. These two tables are small,
 * hand-registered lookups (id equals the human-readable slug), not per-run crosswalked entities,
 * so a plain upsert-by-id is enough -- no external_ref involvement.
 */

import type { PoolClient } from 'pg';

export interface GameRow {
  id: string;
  slug: string;
  name: string;
}

export interface SourceRow {
  id: string;
  slug: string;
  name: string;
  organizer: string;
  baseUrl: string;
}

export async function ensureGame(client: PoolClient, game: GameRow): Promise<void> {
  await client.query(
    `INSERT INTO game (id, slug, name) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET slug = EXCLUDED.slug, name = EXCLUDED.name`,
    [game.id, game.slug, game.name],
  );
}

export async function ensureSource(client: PoolClient, source: SourceRow): Promise<void> {
  await client.query(
    `INSERT INTO source (id, slug, name, organizer, base_url, enabled)
     VALUES ($1, $2, $3, $4, $5, true)
     ON CONFLICT (id) DO UPDATE SET
       slug = EXCLUDED.slug, name = EXCLUDED.name, organizer = EXCLUDED.organizer, base_url = EXCLUDED.base_url`,
    [source.id, source.slug, source.name, source.organizer, source.baseUrl],
  );
}
