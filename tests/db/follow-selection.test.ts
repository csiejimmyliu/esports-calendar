/**
 * DB-backed stage 2a tests.
 *
 * What needs a real Postgres to mean anything, as opposed to `tests/calendar.test.ts` which is the
 * pure-function half:
 *
 *   - the primary keys are what make follow/selection writes idempotent, and `ON CONFLICT` against
 *     a real constraint is the only honest way to assert that;
 *   - keyset paging's whole purpose is to survive a concurrent insert, which needs a database to
 *     actually insert into;
 *   - NFR-8 asserted from the *write* side: a selection written by a user, then a real sync run
 *     over it. `sync-ingest.test.ts` asserts the same invariant from the sync side.
 */

import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { composeCalendar } from '../../src/core/calendar.js';
import { addFollow, listFollows, removeFollow } from '../../src/db/queries/follows.js';
import { listOverviewMatches } from '../../src/db/queries/overview.js';
import { clearSelection, listSelections, setSelection } from '../../src/db/queries/selections.js';
import { createAnonymousUser, findUserByToken } from '../../src/db/queries/users.js';
import { createRiotRestLolAdapter, fixtureTransport } from '../../src/sources/riot/rest/adapter.js';
import { runSync } from '../../src/sync/ingest.js';
import { findSource } from '../../src/sync/registry.js';
import { CRAWL_FIXTURE_CAPTURED_AT, loadCrawlFixture, loadFixture, realLeagueConfig } from '../fixtures.js';
import { setupTestDb, truncateAll } from './setup.js';

let pool: Pool;
let client: PoolClient;

beforeAll(async () => {
  pool = await setupTestDb();
});

afterAll(async () => {
  // Release before ending: `pool.end()` waits for every checked-out client, and beforeEach holds
  // one for the whole file.
  client?.release();
  await pool.end();
});

beforeEach(async () => {
  await truncateAll(pool);
  client?.release();
  client = await pool.connect();
});

// ---------------------------------------------------------------------------
// Hand-seeded fixture: three LCK matches an hour apart, two teams, one league.
// Hand-seeded rather than synced so the instants and ids are stated in the test itself — paging
// assertions are unreadable against 436 crawled events.
// ---------------------------------------------------------------------------

const LEAGUE = 'league-lck';
const TEAM_A = 'team-a';
const TEAM_B = 'team-b';

/** Three matches, ascending, one hour apart. `m2` is the middle one. */
const SEED_TIMES: [string, string][] = [
  ['m1', '2026-08-20T08:00:00Z'],
  ['m2', '2026-08-20T09:00:00Z'],
  ['m3', '2026-08-20T10:00:00Z'],
];

async function seed(): Promise<string> {
  await client.query(`INSERT INTO game (id, slug, name) VALUES ('lol', 'lol', 'League of Legends')`);
  await client.query(
    `INSERT INTO source (id, slug, name, organizer, base_url)
     VALUES ('riot-rest-lol', 'riot-rest-lol', 'Riot REST', 'Riot', 'https://example.invalid')`,
  );
  await client.query(
    `INSERT INTO league (id, game_id, slug, name, tier, kind) VALUES ($1, 'lol', 'lck', 'LCK', 'major', 'region')`,
    [LEAGUE],
  );
  await client.query(
    `INSERT INTO team (id, game_id, name, code) VALUES ($1, 'lol', 'Team A', 'TA'), ($2, 'lol', 'Team B', 'TB')`,
    [TEAM_A, TEAM_B],
  );

  for (const [id, startsAt] of SEED_TIMES) {
    await insertSeedMatch(id, startsAt);
  }

  const { rows } = await client.query<{ id: string }>(`INSERT INTO app_user (email) VALUES (NULL) RETURNING id`);
  const userId = rows[0]?.id;
  if (userId === undefined) throw new Error('seed: no user id');
  return userId;
}

async function insertSeedMatch(id: string, startsAtUtc: string, state = 'unstarted'): Promise<void> {
  await client.query(
    `INSERT INTO match (id, league_id, starts_at_utc, best_of, games_played, block_name, state)
     VALUES ($1, $2, $3, 3, 0, 'Week 11', $4::match_state)`,
    [id, LEAGUE, startsAtUtc, state],
  );
  await client.query(
    `INSERT INTO match_team (match_id, side_index, team_id) VALUES ($1, 0, $2), ($1, 1, $3)`,
    [id, TEAM_A, TEAM_B],
  );
  // The overview filters by game through external_ref (see overview.ts); without this row the
  // match is invisible, which is itself the behaviour under test in one case below.
  await client.query(
    `INSERT INTO external_ref (entity_type, entity_id, source_id, game_id, external_id)
     VALUES ('match', $1, 'riot-rest-lol', 'lol', $2)`,
    [id, `ext-${id}`],
  );
}

// ---------------------------------------------------------------------------

describe('anonymous identity', () => {
  it('creates an app_user with no email and addresses it by a token that is not its id', async () => {
    const { userId, token } = await createAnonymousUser(client);

    const { rows } = await client.query<{ email: string | null }>('SELECT email FROM app_user WHERE id = $1', [
      userId,
    ]);
    expect(rows[0]?.email).toBeNull();
    expect(token).not.toBe(userId);
    expect(token.length).toBeGreaterThanOrEqual(43); // 32 bytes base64url
    expect(await findUserByToken(client, token)).toBe(userId);
  });

  it('issues a distinct token per user', async () => {
    const a = await createAnonymousUser(client);
    const b = await createAnonymousUser(client);
    expect(a.token).not.toBe(b.token);
    expect(await findUserByToken(client, b.token)).toBe(b.userId);
  });

  it('answers null for an unknown token, indistinguishably from a malformed one', async () => {
    expect(await findUserByToken(client, 'not-a-real-token')).toBeNull();
    expect(await findUserByToken(client, '')).toBeNull();
  });
});

describe('follow writes', () => {
  it('is idempotent: following twice leaves one row and reports the second as a no-op', async () => {
    const userId = await seed();

    expect(await addFollow(client, userId, { targetType: 'league', targetId: LEAGUE })).toBe(true);
    expect(await addFollow(client, userId, { targetType: 'league', targetId: LEAGUE })).toBe(false);

    expect(await listFollows(client, userId)).toEqual([{ targetType: 'league', targetId: LEAGUE }]);
  });

  it('treats a league and a team with the same target id as different follows', async () => {
    const userId = await seed();
    await addFollow(client, userId, { targetType: 'league', targetId: 'x' });
    await addFollow(client, userId, { targetType: 'team', targetId: 'x' });
    expect(await listFollows(client, userId)).toHaveLength(2);
  });

  it('unfollowing deletes no selection — FR-1 rule 3', async () => {
    const userId = await seed();
    await addFollow(client, userId, { targetType: 'team', targetId: TEAM_A });
    await setSelection(client, userId, { matchId: 'm1', state: 'included' });
    await setSelection(client, userId, { matchId: 'm2', state: 'excluded' });

    await removeFollow(client, userId, { targetType: 'team', targetId: TEAM_A });

    expect(await listFollows(client, userId)).toEqual([]);
    expect(await listSelections(client, userId)).toEqual([
      { matchId: 'm1', state: 'included' },
      { matchId: 'm2', state: 'excluded' },
    ]);
  });
});

describe('selection writes', () => {
  it('keeps one row per (user, match) when the state flips — FR-1 rule 2', async () => {
    const userId = await seed();
    await setSelection(client, userId, { matchId: 'm1', state: 'included' });
    await setSelection(client, userId, { matchId: 'm1', state: 'excluded' });

    expect(await listSelections(client, userId)).toEqual([{ matchId: 'm1', state: 'excluded' }]);
  });

  it('does not move updated_at when the same state is re-asserted', async () => {
    // Stage 4's account merge will need updated_at to mean "changed their mind", not "the client
    // re-sent the same thing". Same guard as updateMatch in src/db/queries/matches.ts.
    const userId = await seed();
    await setSelection(client, userId, { matchId: 'm1', state: 'included' });
    const first = await selectionUpdatedAt(userId, 'm1');

    await setSelection(client, userId, { matchId: 'm1', state: 'included' });
    expect(await selectionUpdatedAt(userId, 'm1')).toEqual(first);

    await setSelection(client, userId, { matchId: 'm1', state: 'excluded' });
    expect(await selectionUpdatedAt(userId, 'm1')).not.toEqual(first);
  });

  it('clearSelection removes the statement entirely, unlike excluding', async () => {
    const userId = await seed();
    await setSelection(client, userId, { matchId: 'm1', state: 'excluded' });
    expect(await clearSelection(client, userId, 'm1')).toBe(true);
    expect(await listSelections(client, userId)).toEqual([]);
    expect(await clearSelection(client, userId, 'm1')).toBe(false);
  });
});

async function selectionUpdatedAt(userId: string, matchId: string): Promise<string> {
  const { rows } = await client.query<{ updated_at: Date }>(
    'SELECT updated_at FROM selection WHERE user_id = $1 AND match_id = $2',
    [userId, matchId],
  );
  const value = rows[0]?.updated_at;
  if (value === undefined) throw new Error('selectionUpdatedAt: no row');
  return value.toISOString();
}

describe('overview paging', () => {
  const ANCHOR = '2026-08-20T00:00:00Z';

  it('pages forward by keyset and stops when the page is not full', async () => {
    await seed();

    const first = await listOverviewMatches(client, { game: 'lol', anchor: ANCHOR, direction: 'forward', limit: 2 });
    expect(first.matches.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(first.nextCursor).toEqual({ startsAtUtc: '2026-08-20T09:00:00Z', id: 'm2' });

    const second = await listOverviewMatches(client, {
      game: 'lol',
      anchor: ANCHOR,
      direction: 'forward',
      limit: 2,
      ...(first.nextCursor === null ? {} : { cursor: first.nextCursor }),
    });
    expect(second.matches.map((m) => m.id)).toEqual(['m3']);
    expect(second.nextCursor).toBeNull();
  });

  it('does not skip or repeat when sync inserts a match above the cursor mid-scroll', async () => {
    // The reason for keyset over OFFSET. With OFFSET 2, inserting a row before the cursor shifts
    // every later row down one and the second page silently re-serves m2.
    await seed();
    const first = await listOverviewMatches(client, { game: 'lol', anchor: ANCHOR, direction: 'forward', limit: 2 });

    await insertSeedMatch('m0', '2026-08-20T07:30:00Z');

    const cursor = first.nextCursor;
    if (cursor === null) throw new Error('expected a cursor');
    const second = await listOverviewMatches(client, {
      game: 'lol',
      anchor: ANCHOR,
      direction: 'forward',
      limit: 2,
      cursor,
    });
    expect(second.matches.map((m) => m.id)).toEqual(['m3']);
  });

  it('pages backward into the past, newest first', async () => {
    await seed();
    const page = await listOverviewMatches(client, {
      game: 'lol',
      anchor: '2026-08-20T09:30:00Z',
      direction: 'backward',
      limit: 5,
    });
    expect(page.matches.map((m) => m.id)).toEqual(['m2', 'm1']);
  });

  it('includes an in-progress match that started before the anchor — FR-2 default range', async () => {
    await seed();
    await insertSeedMatch('m-live', '2026-08-19T23:00:00Z', 'inProgress');

    const page = await listOverviewMatches(client, { game: 'lol', anchor: ANCHOR, direction: 'forward', limit: 10 });
    expect(page.matches.map((m) => m.id)).toEqual(['m-live', 'm1', 'm2', 'm3']);
  });

  it('keeps the default-range rule on page two when in-progress matches overflow a page', async () => {
    // Regression: eligibility ("at or after the anchor, or in progress") and position (the keyset
    // cursor) are separate conditions and both must apply to every page. When they were an
    // if/else, a first page filled entirely with in-progress matches left a cursor still earlier
    // than the anchor, and page two admitted `m-stale` — neither in progress nor in the future.
    await seed();
    await insertSeedMatch('m-live-1', '2026-08-19T20:00:00Z', 'inProgress');
    await insertSeedMatch('m-live-2', '2026-08-19T21:00:00Z', 'inProgress');
    await insertSeedMatch('m-stale', '2026-08-19T22:00:00Z', 'unstarted');

    const first = await listOverviewMatches(client, { game: 'lol', anchor: ANCHOR, direction: 'forward', limit: 2 });
    expect(first.matches.map((m) => m.id)).toEqual(['m-live-1', 'm-live-2']);

    const cursor = first.nextCursor;
    if (cursor === null) throw new Error('expected a cursor');
    const second = await listOverviewMatches(client, {
      game: 'lol',
      anchor: ANCHOR,
      direction: 'forward',
      limit: 2,
      cursor,
    });
    expect(second.matches.map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it('filters by league and by team without writing anything — FR-2', async () => {
    await seed();
    const before = await tableSnapshot();

    const byLeague = await listOverviewMatches(client, {
      game: 'lol',
      anchor: ANCHOR,
      direction: 'forward',
      limit: 10,
      leagueIds: ['league-lec'],
    });
    expect(byLeague.matches).toEqual([]);

    const byTeam = await listOverviewMatches(client, {
      game: 'lol',
      anchor: ANCHOR,
      direction: 'forward',
      limit: 10,
      teamIds: [TEAM_A],
    });
    expect(byTeam.matches.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);

    expect(await tableSnapshot()).toEqual(before);
  });

  it('returns the domain shape, with resolved teams and no fabricated end time', async () => {
    await seed();
    const page = await listOverviewMatches(client, { game: 'lol', anchor: ANCHOR, direction: 'forward', limit: 1 });
    const match = page.matches[0];
    if (match === undefined) throw new Error('expected a match');

    expect(match).toMatchObject({
      id: 'm1',
      game: 'lol',
      leagueId: LEAGUE,
      startsAtUtc: '2026-08-20T08:00:00Z',
      state: 'unstarted',
      seriesLength: 3,
      stageLabel: 'Week 11',
      streamUrl: null,
    });
    expect(match.sides.map((s) => s.team?.id)).toEqual([TEAM_A, TEAM_B]);
    expect(match).not.toHaveProperty('endsAtUtc');
  });

  it('leaves a TBD side null rather than dropping the match', async () => {
    await seed();
    await client.query(`UPDATE match_team SET team_id = NULL WHERE match_id = 'm1' AND side_index = 1`);

    const page = await listOverviewMatches(client, { game: 'lol', anchor: ANCHOR, direction: 'forward', limit: 1 });
    expect(page.matches[0]?.sides[1].team).toBeNull();
    expect(page.matches[0]?.sides[0].team?.id).toBe(TEAM_A);
  });
});

describe('the overview and the calendar compose', () => {
  it('a followed league plus one exclusion yields the user calendar the pure function describes', async () => {
    const userId = await seed();
    await addFollow(client, userId, { targetType: 'league', targetId: LEAGUE });
    await setSelection(client, userId, { matchId: 'm2', state: 'excluded' });

    const page = await listOverviewMatches(client, {
      game: 'lol',
      anchor: '2026-08-20T00:00:00Z',
      direction: 'forward',
      limit: 10,
    });
    const calendar = composeCalendar({
      follows: await listFollows(client, userId),
      selections: await listSelections(client, userId),
      matches: page.matches,
    });

    expect(calendar.map((m) => m.id)).toEqual(['m1', 'm3']);
  });
});

describe('NFR-8 from the write side', () => {
  it('a real sync run over a match the user selected leaves the selection untouched', async () => {
    // sync-ingest.test.ts asserts this from the sync side (nothing in src/sync/ names `selection`).
    // This asserts it end-to-end: a user's row, written first, survives ingestion of the same match.
    const source = findSource('riot-rest-lol');
    const leagueConfig = realLeagueConfig();
    const adapter = createRiotRestLolAdapter(
      fixtureTransport({
        schedule: loadCrawlFixture('riot-lol/rest_getSchedule_crawl_2026-08-12'),
        leagues: loadFixture('riot-lol/rest_getLeagues.json'),
        teams: loadFixture('riot-lol/rest_getTeams.json'),
      }),
      leagueConfig,
    );
    // Fixed reference clock: the crawl fixture's capture date, never system time (CLAUDE.md).
    const now = new Date(CRAWL_FIXTURE_CAPTURED_AT);

    await runSync(pool, source, adapter, leagueConfig, now);

    const { rows } = await client.query<{ id: string }>('SELECT id FROM match ORDER BY starts_at_utc LIMIT 1');
    const matchId = rows[0]?.id;
    if (matchId === undefined) throw new Error('sync produced no matches');

    const { userId } = await createAnonymousUser(client);
    await setSelection(client, userId, { matchId, state: 'excluded' });
    const before = await selectionUpdatedAt(userId, matchId);

    await runSync(pool, source, adapter, leagueConfig, now);

    expect(await listSelections(client, userId)).toEqual([{ matchId, state: 'excluded' }]);
    expect(await selectionUpdatedAt(userId, matchId)).toEqual(before);
  });
});

/** Row counts for every table a read is forbidden from touching. FR-2: a filter issues no write. */
async function tableSnapshot(): Promise<Record<string, number>> {
  const tables = ['follow', 'selection', 'match', 'match_team', 'team', 'league', 'external_ref'];
  const out: Record<string, number> = {};
  for (const t of tables) {
    const { rows } = await client.query<{ count: string }>(`SELECT count(*)::text FROM ${t}`);
    out[t] = Number(rows[0]?.count ?? '0');
  }
  return out;
}
