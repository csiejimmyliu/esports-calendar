/**
 * DB-backed sync tests.
 *
 * Stage 1a's acceptance criterion, demonstrated against Postgres rather than asserted: "sync
 * twice → zero duplicates. TBD matches persist." Plus NFR-8 and the crosswalk's manual_override
 * guarantee, which need a real database to be meaningful.
 *
 * Stage 1b adds: a degraded `getTeams` must not erase an already-resolved team id or bump every
 * match's revision; a match that stops parsing must not be read as a cancellation; a broken scope
 * or a broken `fetchLeagues` must not fail the run or roll back a healthy sibling; a genuinely
 * unchanged second run must not move `updated_at`; and every run — including a failed one — must
 * leave a `sync_run`/`source_health` record and, when a scope was actually evaluated, a
 * `canary_result` per canary.
 *
 * All against the committed forward-crawl fixture (fixtures/riot-lol/rest_getSchedule_crawl_2026-08-12/),
 * pinned to CRAWL_FIXTURE_CAPTURED_AT per the fixed-reference-clock convention.
 */

import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createRiotRestLolAdapter, fixtureTransport } from '../../src/sources/riot/rest/adapter.js';
import type { RiotRestTransport } from '../../src/sources/riot/rest/adapter.js';
import type { SourceAdapter } from '../../src/core/source.js';
import { runSync } from '../../src/sync/ingest.js';
import { findSource } from '../../src/sync/registry.js';
import { CRAWL_FIXTURE_CAPTURED_AT, loadCrawlFixture, loadFixture, realLeagueConfig, scheduleEnvelope } from '../fixtures.js';
import { setupTestDb, truncateAll } from './setup.js';

const NOW = new Date(CRAWL_FIXTURE_CAPTURED_AT);

function crawlTransport(overrides: Partial<RiotRestTransport> = {}): RiotRestTransport {
  const schedule = loadCrawlFixture('riot-lol/rest_getSchedule_crawl_2026-08-12');
  const leagues = loadFixture('riot-lol/rest_getLeagues.json');
  const teams = loadFixture('riot-lol/rest_getTeams.json');
  return { ...fixtureTransport({ schedule, leagues, teams }), ...overrides };
}

function buildAdapter(transport: RiotRestTransport = crawlTransport()): SourceAdapter {
  return createRiotRestLolAdapter(transport, realLeagueConfig());
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

async function matchTeamIds(pool: Pool): Promise<Map<string, [string | null, string | null]>> {
  const { rows } = await pool.query<{ match_id: string; side_index: number; team_id: string | null }>(
    'SELECT match_id, side_index, team_id FROM match_team',
  );
  const out = new Map<string, [string | null, string | null]>();
  for (const r of rows) {
    const pair = out.get(r.match_id) ?? [null, null];
    pair[r.side_index] = r.team_id;
    out.set(r.match_id, pair);
  }
  return out;
}

async function latestSyncRun(
  pool: Pool,
  sourceId: string,
): Promise<{ status: string; item_count: number | null; detail: string | null } | undefined> {
  const { rows } = await pool.query<{ status: string; item_count: number | null; detail: string | null }>(
    'SELECT status, item_count, detail FROM sync_run WHERE source_id = $1 ORDER BY started_at DESC LIMIT 1',
    [sourceId],
  );
  return rows[0];
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

    const first = await runSync(pool, entry, buildAdapter(), realLeagueConfig(), NOW);
    expect(first.matchesFetched).toBeGreaterThan(0);
    expect(first.matchesInserted).toBe(first.matchesFetched);
    expect(first.matchesUpdated).toBe(0);
    expect(first.matchesCancelled).toBe(0);

    const countsAfterFirst = await tableCounts(pool);
    const revisionsAfterFirst = await pool.query<{ revision: number }>('SELECT revision FROM match ORDER BY id');

    const second = await runSync(pool, entry, buildAdapter(), realLeagueConfig(), NOW);
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

  it('a truly unchanged second run does not move updated_at either — not just revision', async () => {
    // The stricter claim than "zero duplicates": a second run over identical data must not even
    // rewrite the row. Stage 1a's own test only checked `revision`; a plain UPDATE with no
    // IS DISTINCT FROM guard would still pass that test while moving `updated_at` on every match,
    // on every run, forever. See src/db/queries/matches.ts's updateMatch.
    const entry = findSource('riot-rest-lol');
    await runSync(pool, entry, buildAdapter(), realLeagueConfig(), NOW);
    const before = await pool.query<{ id: string; updated_at: string }>('SELECT id, updated_at FROM match ORDER BY id');

    await runSync(pool, entry, buildAdapter(), realLeagueConfig(), NOW);
    const after = await pool.query<{ id: string; updated_at: string }>('SELECT id, updated_at FROM match ORDER BY id');

    expect(after.rows).toEqual(before.rows);
  });

  it('a TBD match persists across a second sync without inventing a phantom team', async () => {
    const entry = findSource('riot-rest-lol');
    // 117030752644841571: an lck (covered, major) match with both sides TBD in the committed
    // crawl fixture — see the grep against rest_getSchedule_crawl_2026-08-12 that found it.
    const externalId = '117030752644841571';

    await runSync(pool, entry, buildAdapter(), realLeagueConfig(), NOW);

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

    await runSync(pool, entry, buildAdapter(), realLeagueConfig(), NOW);

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

  it('a degraded getTeams preserves previously resolved team ids and does not bump revision', async () => {
    // The A1 regression: adapter.ts degrades a failed getTeams to `externalId: null` on every
    // named side, which used to be written straight into match_team.team_id, overwriting an
    // identity a healthy run had already resolved.
    const entry = findSource('riot-rest-lol');

    await runSync(pool, entry, buildAdapter(), realLeagueConfig(), NOW);
    const idsAfterHealthy = await matchTeamIds(pool);
    const revisionsAfterHealthy = await pool.query<{ id: string; revision: number }>(
      'SELECT id, revision FROM match ORDER BY id',
    );
    // Sanity: the healthy run actually resolved some teams, or this test would pass vacuously.
    const resolvedCount = [...idsAfterHealthy.values()].filter(([a, b]) => a !== null || b !== null).length;
    expect(resolvedCount).toBeGreaterThan(0);

    const degradedTeams = crawlTransport({ getTeams: () => Promise.reject(new Error('503')) });
    const second = await runSync(pool, entry, buildAdapter(degradedTeams), realLeagueConfig(), NOW);
    expect(second.matchesCancelled).toBe(0);

    const idsAfterDegraded = await matchTeamIds(pool);
    expect(idsAfterDegraded).toEqual(idsAfterHealthy);

    const revisionsAfterDegraded = await pool.query<{ id: string; revision: number }>(
      'SELECT id, revision FROM match ORDER BY id',
    );
    expect(revisionsAfterDegraded.rows).toEqual(revisionsAfterHealthy.rows);
  });

  it('a match that stops parsing is not read as a cancellation', async () => {
    // The A2 regression: a schema-validation failure or a missing `match` object used to vanish
    // from `fetchedExternalIds` entirely, which — with `crawlComplete` still true — read exactly
    // like the match having been pulled from the schedule. To actually exercise the fix (and not
    // pass vacuously), the second fetch must still resolve fromUtc/toUtc — i.e. still contain
    // *some* real matches — while one previously-known match's event corrupts. A wholly empty
    // fetch never even reaches the cancellation code (fromUtc/toUtc stay null), so it would prove
    // nothing about this regression either way.
    const entry = findSource('riot-rest-lol');
    await runSync(pool, entry, buildAdapter(), realLeagueConfig(), NOW);
    const { rows: before } = await pool.query<{ count: string }>(
      `SELECT count(*)::text FROM match WHERE state = 'cancelled'`,
    );
    expect(before[0]?.count).toBe('0');

    const pages = loadCrawlFixture('riot-lol/rest_getSchedule_crawl_2026-08-12') as {
      data: { schedule: { events: unknown[] } };
    }[];
    const corruptedPages = JSON.parse(JSON.stringify(pages)) as typeof pages;
    const firstPageEvents = corruptedPages[0]?.data.schedule.events;
    expect(firstPageEvents?.length).toBeGreaterThan(0);
    // Corrupt the first event on page 1 in place — every other event on every page still parses,
    // so this fetch still has real matches and a real horizon; only this one match's id goes
    // unidentified.
    if (firstPageEvents) firstPageEvents[0] = { nonsense: true };

    const broken = buildAdapter(
      fixtureTransport({
        schedule: corruptedPages,
        leagues: loadFixture('riot-lol/rest_getLeagues.json'),
        teams: loadFixture('riot-lol/rest_getTeams.json'),
      }),
    );
    const second = await runSync(pool, entry, broken, realLeagueConfig(), NOW);
    expect(second.matchesFetched).toBeGreaterThan(0);
    expect(second.matchesCancelled).toBe(0);

    const { rows: after } = await pool.query<{ count: string }>(
      `SELECT count(*)::text FROM match WHERE state = 'cancelled'`,
    );
    expect(after[0]?.count).toBe('0');
  });

  it('a broken scope does not fail the run, and previously-ingested matches survive it', async () => {
    // The A3 regression: fetchMatches throwing used to roll back the whole (single, source-wide)
    // transaction. Now the healthy first run's data must still be there after a broken second run,
    // and runSync itself must not throw.
    const entry = findSource('riot-rest-lol');
    const first = await runSync(pool, entry, buildAdapter(), realLeagueConfig(), NOW);
    const countsAfterFirst = await tableCounts(pool);

    const broken = buildAdapter(crawlTransport({ getSchedule: () => Promise.reject(new Error('upstream down')) }));
    const second = await runSync(pool, entry, broken, realLeagueConfig(), NOW);

    expect(second.scopesProcessed).toBe(0);
    expect(second.scopesFailed).toBe(1);
    expect(second.scopeFailures[0]?.message).toContain('upstream down');
    expect(second.fatal).toBeNull();

    const countsAfterSecond = await tableCounts(pool);
    expect(countsAfterSecond).toEqual(countsAfterFirst);

    const run = await latestSyncRun(pool, entry.source.id);
    expect(run?.status).toBe('failed');
    expect(run?.detail).toContain('upstream down');

    const { rows: health } = await pool.query<{ status: string; consecutive_failures: number }>(
      'SELECT status, consecutive_failures FROM source_health WHERE source_id = $1',
      [entry.source.id],
    );
    expect(health[0]?.status).toBe('failed');
    expect(health[0]?.consecutive_failures).toBe(1);
    expect(first.matchesFetched).toBeGreaterThan(0);
  });

  it('a total getLeagues outage does not stop matches from ingesting, just their league ids', async () => {
    // runSync's own adapter.fetchLeagues() call and fetchMatches' internal getLeagues call share
    // one upstream endpoint; a real outage takes both down at once, so no match carries a
    // leagueExternalId this run and the per-match fallback (below) has nothing to key on either.
    // Matches still land — just without a league — rather than the whole run being rolled back.
    const entry = findSource('riot-rest-lol');
    const degradedLeagues = crawlTransport({ getLeagues: () => Promise.reject(new Error('leagues down')) });
    const report = await runSync(pool, entry, buildAdapter(degradedLeagues), realLeagueConfig(), NOW);

    expect(report.fatal).toBeNull();
    expect(report.leaguesUpserted).toBe(0);
    expect(report.matchesInserted).toBeGreaterThan(0);
    expect(report.warnings.some((w) => w.code === 'degraded-fetch')).toBe(true);

    const { rows } = await pool.query<{ count: string }>(`SELECT count(*)::text FROM match WHERE league_id IS NULL`);
    expect(Number(rows[0]?.count)).toBe(report.matchesInserted);
  });

  it('fetchLeagues failing while the internal getLeagues call still succeeds falls back to the per-match league', async () => {
    // The narrower, realistic case the fallback in src/sync/ingest.ts's upsertMatchAndSides
    // exists for: runSync's own top-level adapter.fetchLeagues() call (the first getLeagues
    // request of the run) fails, but fetchMatches' internal getLeagues call (the second) does not
    // — so every SourceMatch still carries a real leagueExternalId, `leagueIdBySlug` just never
    // got populated from it. Each match resolves its own minimal league row instead of losing its
    // league association entirely.
    const entry = findSource('riot-rest-lol');
    const leagues = loadFixture('riot-lol/rest_getLeagues.json');
    let getLeaguesCalls = 0;
    const flakyLeagues = crawlTransport({
      getLeagues: () => {
        getLeaguesCalls += 1;
        return getLeaguesCalls === 1
          ? Promise.reject(new Error('leagues down'))
          : Promise.resolve({ json: leagues, bytes: 0 });
      },
    });
    const report = await runSync(pool, entry, buildAdapter(flakyLeagues), realLeagueConfig(), NOW);

    expect(report.fatal).toBeNull();
    expect(report.leaguesUpserted).toBe(0);
    expect(report.matchesInserted).toBeGreaterThan(0);
    expect(report.warnings.some((w) => w.code === 'degraded-fetch')).toBe(true);

    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text FROM match WHERE league_id IS NOT NULL`,
    );
    expect(Number(rows[0]?.count)).toBe(report.matchesInserted);
  });

  it('a zero-row fetch fails the canaries, records them, and still commits (degraded, not failed)', async () => {
    const entry = findSource('riot-rest-lol');
    const empty = buildAdapter(crawlTransport({ getSchedule: () => Promise.resolve({ json: scheduleEnvelope([]), bytes: 0 }) }));
    const report = await runSync(pool, entry, empty, realLeagueConfig(), NOW);

    expect(report.scopesFailed).toBe(0);
    expect(report.canaryResults.length).toBeGreaterThan(0);
    expect(report.canaryResults.some((c) => !c.ok)).toBe(true);

    const run = await latestSyncRun(pool, entry.source.id);
    expect(run?.status).toBe('degraded');

    const { rows: canaryRows } = await pool.query<{ canary_key: string; ok: boolean }>(
      'SELECT canary_key, ok FROM canary_result WHERE source_id = $1',
      [entry.source.id],
    );
    expect(canaryRows.length).toBe(report.canaryResults.length);
    expect(canaryRows.some((r) => !r.ok)).toBe(true);
  });

  it('NFR-8: a user selection row is never touched by sync', async () => {
    const entry = findSource('riot-rest-lol');
    await runSync(pool, entry, buildAdapter(), realLeagueConfig(), NOW);

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
    await pool.query(`INSERT INTO follow (user_id, target_type, target_id) VALUES ($1, 'team', 'some-team-id')`, [
      userId,
    ]);
    const selectionBefore = await pool.query('SELECT * FROM selection WHERE user_id = $1', [userId]);
    const followBefore = await pool.query('SELECT * FROM follow WHERE user_id = $1', [userId]);

    await runSync(pool, entry, buildAdapter(), realLeagueConfig(), NOW);

    const selectionAfter = await pool.query('SELECT * FROM selection WHERE user_id = $1', [userId]);
    const followAfter = await pool.query('SELECT * FROM follow WHERE user_id = $1', [userId]);
    expect(selectionAfter.rows).toEqual(selectionBefore.rows);
    expect(followAfter.rows).toEqual(followBefore.rows);
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

    await runSync(pool, entry, buildAdapter(), realLeagueConfig(), NOW);

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
