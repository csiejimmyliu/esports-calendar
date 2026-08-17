/**
 * Anonymous identity (SPEC §2 FR-1, CLAUDE.md's non-negotiable list).
 *
 * An anonymous user is an `app_user` row with `email IS NULL` — not a guest table, not a parallel
 * code path — addressed by an opaque bearer token in `user_token`. Stage 4 turns that row into an
 * account by writing `email` or merging it into an existing one; no `follow` or `selection` row
 * moves in the common case.
 *
 * The token is deliberately not `app_user.id`. The id is free to appear in logs, error messages
 * and links precisely because holding it grants nothing; a value that is both an identifier and a
 * credential is compromised the first time it is written to a log line. FR-5 states the same rule
 * for ICS, and `ics_token` stays a separate table with separate power: read-only, and travelling
 * inside a URL rather than a header.
 */

import { randomBytes } from 'node:crypto';

import type { PoolClient } from 'pg';

export interface AnonymousUser {
  userId: string;
  /** Returned exactly once, at creation. Never read back — the row is the only copy after this. */
  token: string;
}

/**
 * 32 bytes of cryptographic randomness, base64url so it survives a header and a URL unescaped.
 *
 * The one security property this design actually depends on is unguessability: there is no
 * password, no second factor and no recovery path (there is no email to send one to), so an
 * enumerable token — a counter, a timestamp, a v1 uuid — would be the whole vulnerability. SPEC
 * §2 FR-1 states the accepted risk in full.
 */
function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Creates the user and its first token together.
 *
 * The caller owns the transaction (every other module in this directory takes a `PoolClient` for
 * the same reason), so a failure between the two inserts cannot leave an addressable-by-nobody
 * user row behind.
 */
export async function createAnonymousUser(client: PoolClient): Promise<AnonymousUser> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO app_user (email) VALUES (NULL) RETURNING id`,
  );
  const row = rows[0];
  if (row === undefined) throw new Error('createAnonymousUser: INSERT ... RETURNING produced no row');

  const token = newToken();
  await client.query(`INSERT INTO user_token (token, user_id) VALUES ($1, $2)`, [token, row.id]);
  return { userId: row.id, token };
}

/**
 * The user this token addresses, or null.
 *
 * One indistinguishable answer for "no such token" and "malformed token" is intentional and is
 * stage 2b's acceptance criterion: the caller must not be able to tell a wrong token from a
 * well-formed one that has been revoked.
 */
export async function findUserByToken(client: PoolClient, token: string): Promise<string | null> {
  const { rows } = await client.query<{ user_id: string }>(
    `SELECT user_id FROM user_token WHERE token = $1`,
    [token],
  );
  return rows[0]?.user_id ?? null;
}
