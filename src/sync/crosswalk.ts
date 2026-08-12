/**
 * Identity crosswalk: source ids are aliases in `external_ref`, never primary keys (CLAUDE.md,
 * SPEC §5).
 *
 * `resolveOrCreate` is the whole mechanism: look up (entityType, sourceId, game, externalId) in
 * `external_ref`; if it exists, return the canonical id it already points at — untouched — and
 * say so; if not, create the entity and the crosswalk row together and return the new id.
 *
 * This is also where `external_ref.manual_override` gets its only consumer. A row with
 * `manual_override = true` was set or confirmed by a human, and the function above already
 * satisfies "sync must not re-derive it": `resolveOrCreate` never rewrites an existing mapping,
 * manual or not — it only ever inserts one that is missing. What it *does* still do for a manual
 * row is update the entity's own fields (name, logo, ...) via the caller's normal upsert path;
 * the protection is about which canonical id an external id resolves to, not about whether that
 * entity's denormalized fields stay fresh. SPEC §5 tabulates why this is a different mechanism
 * from `config/leagues.json`'s `teamOverrides`, which runs at parse time inside the adapter,
 * before any database exists.
 */

import type { PoolClient } from 'pg';

export type EntityType = 'league' | 'tournament' | 'team' | 'match';

export interface CrosswalkResult {
  entityId: string;
  /** False if this (entityType, sourceId, game, externalId) had never been seen before. */
  isNew: boolean;
  manualOverride: boolean;
}

export async function resolveOrCreate(
  client: PoolClient,
  entityType: EntityType,
  sourceId: string,
  game: string,
  externalId: string,
  createEntity: () => Promise<string>,
): Promise<CrosswalkResult> {
  const existing = await client.query<{ entity_id: string; manual_override: boolean }>(
    `SELECT entity_id, manual_override FROM external_ref
     WHERE entity_type = $1 AND source_id = $2 AND game_id = $3 AND external_id = $4`,
    [entityType, sourceId, game, externalId],
  );
  const row = existing.rows[0];
  if (row !== undefined) {
    return { entityId: row.entity_id, isNew: false, manualOverride: row.manual_override };
  }

  const entityId = await createEntity();
  await client.query(
    `INSERT INTO external_ref (entity_type, entity_id, source_id, game_id, external_id, is_canonical, manual_override)
     VALUES ($1, $2, $3, $4, $5, true, false)`,
    [entityType, entityId, sourceId, game, externalId],
  );
  return { entityId, isNew: true, manualOverride: false };
}
