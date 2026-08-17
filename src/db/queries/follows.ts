/**
 * `follow` reads and writes (SPEC §2 FR-1).
 *
 * A follow is a standing rule with no state of its own: it is either there or it is not. That is
 * why this module has no update — and why `addFollow` is `ON CONFLICT DO NOTHING` rather than an
 * upsert. Following something already followed is a no-op, not an error and not a rewrite.
 */

import type { PoolClient } from 'pg';

import type { Follow } from '../../core/types.js';

export async function listFollows(client: PoolClient, userId: string): Promise<Follow[]> {
  const { rows } = await client.query<{ target_type: Follow['targetType']; target_id: string }>(
    `SELECT target_type, target_id FROM follow WHERE user_id = $1 ORDER BY target_type, target_id`,
    [userId],
  );
  return rows.map((r) => ({ targetType: r.target_type, targetId: r.target_id }));
}

/** Returns whether a row was actually inserted, so a caller can distinguish "followed" from "already following". */
export async function addFollow(client: PoolClient, userId: string, follow: Follow): Promise<boolean> {
  const { rowCount } = await client.query(
    `INSERT INTO follow (user_id, target_type, target_id) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, target_type, target_id) DO NOTHING`,
    [userId, follow.targetType, follow.targetId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Removes the standing rule and **nothing else**.
 *
 * SPEC §2 FR-1 rule 3: unfollowing does not delete picks. The matches a user picked by hand while
 * following T1 stay on their calendar, because those were separate explicit statements. This
 * function deliberately does not touch `selection`, and `tests/db/follow-selection.test.ts`
 * asserts that — the deletion that is *absent* here is the requirement.
 */
export async function removeFollow(client: PoolClient, userId: string, follow: Follow): Promise<boolean> {
  const { rowCount } = await client.query(
    `DELETE FROM follow WHERE user_id = $1 AND target_type = $2 AND target_id = $3`,
    [userId, follow.targetType, follow.targetId],
  );
  return (rowCount ?? 0) > 0;
}
