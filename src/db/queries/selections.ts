/**
 * `selection` reads and writes (SPEC §2 FR-1).
 *
 * One row per (user, match) carrying a state, enforced by the table's own primary key. Rule 2 in
 * FR-1 is exactly this: two tables — one for picks, one for drops — would permit a contradictory
 * pair, and `setSelection` collapsing to an upsert is what makes the contradiction unrepresentable
 * rather than merely discouraged.
 *
 * Nothing in `src/sync/` references this table. That absence is how NFR-8 ("a user's explicit
 * selection is never overwritten by sync") is enforced — by construction, not by a trigger.
 */

import type { PoolClient } from 'pg';

import type { Selection } from '../../core/types.js';

export async function listSelections(client: PoolClient, userId: string): Promise<Selection[]> {
  const { rows } = await client.query<{ match_id: string; state: Selection['state'] }>(
    `SELECT match_id, state FROM selection WHERE user_id = $1 ORDER BY match_id`,
    [userId],
  );
  return rows.map((r) => ({ matchId: r.match_id, state: r.state }));
}

/**
 * Picks or drops a match. Idempotent, and `updated_at` only moves when the state actually changed.
 *
 * The `WHERE state IS DISTINCT FROM` guard on the conflict branch mirrors `updateMatch`
 * (src/db/queries/matches.ts) and exists for the same reason: re-asserting a selection the user
 * already holds must not look like a fresh decision to anything reading `updated_at`. Stage 4's
 * account merge is the consumer that will care — most-recent-wins is only meaningful if the
 * timestamp records a real change of mind.
 */
export async function setSelection(
  client: PoolClient,
  userId: string,
  selection: Selection,
): Promise<void> {
  await client.query(
    `INSERT INTO selection (user_id, match_id, state) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, match_id) DO UPDATE
       SET state = EXCLUDED.state, updated_at = now()
       WHERE selection.state IS DISTINCT FROM EXCLUDED.state`,
    [userId, selection.matchId, selection.state],
  );
}

/**
 * Drops the user's statement about this match entirely, returning it to whatever their follows
 * derive.
 *
 * This is **not** what un-picking does — un-picking a derived match writes `excluded`
 * (`setSelection`), because the user is saying something, and FR-1 rules 4 and 5 require that
 * statement to survive both the match finishing and the follow being removed. This function is for
 * "actually, never mind, treat it as if I had said nothing", which is a different action and the
 * only one that may delete a row.
 */
export async function clearSelection(client: PoolClient, userId: string, matchId: string): Promise<boolean> {
  const { rowCount } = await client.query(`DELETE FROM selection WHERE user_id = $1 AND match_id = $2`, [
    userId,
    matchId,
  ]);
  return (rowCount ?? 0) > 0;
}
