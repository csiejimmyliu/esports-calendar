/**
 * DB-backed test setup. Fails loudly when DATABASE_URL is unset rather than skipping — a
 * silently-skipping integration test is exactly the failure mode this repo is built to avoid
 * (CLAUDE.md). Run via `docker compose up -d db && npm run test:db`.
 */

import type { Pool } from 'pg';

import { migrate } from '../../src/db/migrate.js';
import { createPool } from '../../src/db/pool.js';

export async function setupTestDb(): Promise<Pool> {
  if (process.env['DATABASE_URL'] === undefined || process.env['DATABASE_URL'] === '') {
    throw new Error(
      'DATABASE_URL is not set. tests/db/** needs a live Postgres: ' +
        '`docker compose up -d db` then run with DATABASE_URL set (see .env.example). ' +
        'Failing loudly rather than skipping is deliberate.',
    );
  }
  const pool = createPool();
  await migrate(pool);
  return pool;
}

/** Resets every table between tests. Order matches FK dependency (children before parents) —
 *  CASCADE is still present as a second line of defence, not the primary mechanism. */
export async function truncateAll(pool: Pool): Promise<void> {
  await pool.query(`
    TRUNCATE TABLE
      selection, follow, stream_pref, notification_rule, device, ics_token,
      external_ref, stream, match_team, match, tournament, team, league,
      canary_result, sync_run, source_health, source, game, app_user
    RESTART IDENTITY CASCADE
  `);
}
