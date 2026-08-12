/**
 * DB-backed sync tests — the stage 1a acceptance criterion, demonstrated against Postgres rather
 * than asserted: "sync twice → zero duplicates. TBD matches persist." Plus NFR-8 and the
 * crosswalk's manual_override guarantee, which need a real database to be meaningful.
 *
 * All against the committed forward-crawl fixture (fixtures/riot-lol/rest_getSchedule_crawl_2026-08-12/),
 * pinned to CRAWL_FIXTURE_CAPTURED_AT per the fixed-reference-clock convention.
 */

import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createRiotRestLolAdapter, fixtureTransport } from '../../src/sources/riot/rest/adapter.js';
import type { SourceAdapter } from '../../src/core/source.js';
import { runSync } from '../../src/sync/ingest.js';
import { findSource } from '../../src/sync/registry.js';
import { loadCrawlFixture, loadFixture, realLeagueConfig } from '../fixtures.js';
import { setupTestDb, truncateAll } from './setup.js';

function buildAdapter(): SourceAdapter {
  const schedule = loadCrawlFixture('riot-lol/rest_getSchedule_crawl_2026-08-12');
  const leagues = loadFixture('riot-lol/rest_getLeagues.json');
  const teams = loadFixture('riot-lol/rest_getTeams.json');
  return createRiotRestLolAdapter(fixtureTransport({ schedule, leagues, teams }), realLeagueConfig());
}

interface Counts {
  league: number;
  team: number;
  match: number;
  match_team: number;
  external_ref: number;
}

async function tableCounts(pool: Pool): Promise<Counts> {
  const tables = ['league', 'team', 'match', 'match_team', 'external_ref'] as const;
  const counts = {} as Counts;
  for (const t of tables) {
    const { rows } = await pool.query<{ count: string }>(`SELECT count(*)::text FROM ${t}`);
    counts[t] = Number(rows[0]?.count ?? '0');
  }
  return counts;
}

describe('sync ingest (DB-backed)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = await setupTestDb();
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await truncateAll(pool);
  });

  it('running sync twice produces zero duplicates and stable revisions', async () => {
    const entry = findSource('riot-rest-lol');

    const first = await runSync(pool, entry, buildAdapter(), realLeagueConfig());
    expect(first.matchesFetched).toBeGreaterThan(0);
    expect(first.matchesInserted).toBe(first.matchesFetched);
    expect(first.matchesUpdated).toBe(0);
    expect(first.matchesCancelled).toBe(0);

    const countsAfterFirst = await tableCounts(pool);
    const revisionsAfterFirst = await pool.query<{ revision: number }>('SELECT revision FROM match ORDER BY id');

    const second = await runSync(pool, entry, buildAdapter(), realLeagueConfig());
    expect(second.matchesFetched).toBe(first.matchesFetched);
    expect(second.matchesInserted).toBe(0);
    expect(second.matchesUpdated).toBe(0);
    expect(second.matchesCancelled).toBe(0);
    expect(second.matchesUnchanged).toBe(first.matchesFetched);

    const countsAfterSecond = await tableCounts(pool);
    expect(countsAfterSecond).toEqual(countsAfterFirst);

    const revisionsAfterSecond = await pool.query<{ revision: number }>('SELECT revision FROM match ORDER BY id');
    expect(revisionsAfterSecond.rows).toEqual(revisionsAfterFirst.rows);
    expect(revisionsAfterSecond.rows.every((r) => r.revision === 1)).toBe(true);
  });

  it('a TBD match persists across a second sync without inventing a phantom team', async () => {
    const entry = findSource('riot-rest-lol');
    // 117030752644841571: an lck (covered, major) match with both sides TBD in the committed
    // crawl fixture — see the grep against rest_getSchedule_crawl_2026-08-12 that found it.
    const externalId = '117030752644841571';

    await runSync(pool, entry, buildAdapter(), realLeagueConfig());

    const { rows: refRows } = await pool.query<{ entity_id: string }>(
      `SELECT entity_id FROM external_ref WHERE entity_type = 'match' AND external_id = $1`,
      [externalId],
    );
    expect(refRows).toHaveLength(1);
    const matchId = refRows[0]?.entity_id;
    expect(matchId).toBeDefined();

    const { rows: sideRows } = await pool.query<{ team_id: string | null }>(
      'SELECT team_id FROM match_team WHERE match_id = $1',
      [matchId],
    );
    expect(sideRows).toHaveLength(2);
    expect(sideRows.every((r) => r.team_id === null)).toBe(true);

    await runSync(pool, entry, buildAdapter(), realLeagueConfig());

    const { rows: refRowsAfter } = await pool.query<{ entity_id: string }>(
      `SELECT entity_id FROM external_ref WHERE entity_type = 'match' AND external_id = $1`,
      [externalId],
    );
    expect(refRowsAfter).toHaveLength(1);
    expect(refRowsAfter[0]?.entity_id).toBe(matchId);

    const { rows: sideRowsAfter } = await pool.query<{ team_id: string | null }>(
      'SELECT team_id FROM match_team WHERE match_id = $1',
      [matchId],
    );
    expect(sideRowsAfter.every((r) => r.team_id === null)).toBe(true);
  });

  it('NFR-8: a user selection row is never touched by sync', async () => {
    const entry = findSource('riot-rest-lol');
    await runSync(pool, entry, buildAdapter(), realLeagueConfig());

    const { rows: matchRows } = await pool.query<{ id: string }>('SELECT id FROM match LIMIT 1');
    const matchId = matchRows[0]?.id;
    expect(matchId).toBeDefined();

    const { rows: userRows } = await pool.query<{ id: string }>(
      `INSERT INTO app_user DEFAULT VALUES RETURNING id`,
    );
    const userId = userRows[0]?.id;
    expect(userId).toBeDefined();

    await pool.query(
      `INSERT INTO selection (user_id, match_id, state, updated_at) VALUES ($1, $2, 'excluded', '2020-01-01T00:00:00Z')`,
      [userId, matchId],
    );
    const before = await pool.query('SELECT * FROM selection WHERE user_id = $1', [userId]);

    await runSync(pool, entry, buildAdapter(), realLeagueConfig());

    const after = await pool.query('SELECT * FROM selection WHERE user_id = $1', [userId]);
    expect(after.rows).toEqual(before.rows);
  });

  it('a manual_override crosswalk row is never rewritten, but the entity it points at still refreshes', async () => {
    const entry = findSource('riot-rest-lol');
    // A match that will appear in the fetch. Pre-seed its crosswalk by hand, pointing at a
    // manually created match row with deliberately wrong content, and mark it manual_override.
    const externalId = '117030752644841571'; // the TBD lck match used above

    const { rows: gameRows } = await pool.query(
      `INSERT INTO game (id, slug, name) VALUES ('lol', 'lol', 'League of Legends') RETURNING id`,
    );
    expect(gameRows).toHaveLength(1);
    await pool.query(
      `INSERT INTO source (id, slug, name, organizer, base_url) VALUES ($1, $1, $1, 'Riot Games', 'x')`,
      [entry.source.id],
    );

    const { rows: matchRows } = await pool.query<{ id: string }>(
      `INSERT INTO match (starts_at_utc, state, revision) VALUES ('2020-01-01T00:00:00Z', 'unstarted', 1) RETURNING id`,
    );
    const handPlacedMatchId = matchRows[0]?.id;
    expect(handPlacedMatchId).toBeDefined();

    await pool.query(
      `INSERT INTO external_ref (entity_type, entity_id, source_id, game_id, external_id, is_canonical, manual_override)
       VALUES ('match', $1, $2, 'lol', $3, true, true)`,
      [handPlacedMatchId, entry.source.id, externalId],
    );

    await runSync(pool, entry, buildAdapter(), realLeagueConfig());

    // The mapping is untouched: still the hand-placed id, still manual_override.
    const { rows: refRows } = await pool.query<{ entity_id: string; manual_override: boolean }>(
      `SELECT entity_id, manual_override FROM external_ref WHERE entity_type = 'match' AND external_id = $1`,
      [externalId],
    );
    expect(refRows).toHaveLength(1);
    expect(refRows[0]?.entity_id).toBe(handPlacedMatchId);
    expect(refRows[0]?.manual_override).toBe(true);

    // But the entity itself refreshed to the real fetched content — the protection is about
    // identity, not about freezing the row's fields.
    const { rows: after } = await pool.query<{ starts_at_utc: string; state: string }>(
      `SELECT starts_at_utc, state FROM match WHERE id = $1`,
      [handPlacedMatchId],
    );
    expect(after[0]?.starts_at_utc).not.toBe('2020-01-01T00:00:00.000Z');
  });
});
