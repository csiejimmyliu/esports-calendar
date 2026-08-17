/**
 * Stage 2b's acceptance criterion (SPEC §8), over real HTTP against real Postgres:
 *
 *   "Every 2a capability is reachable over JSON with no web-only assumption (NFR-1). Applying a
 *    filter issues no write (FR-2). A request with no token, a malformed token, or an unknown
 *    token is rejected without leaking whether the token existed."
 *
 * Each of those three has its own describe block below, plus the routine coverage.
 */

import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { call, startApi } from './helpers.js';
import type { TestApi } from './helpers.js';
import { setupTestDb, truncateAll } from '../db/setup.js';

let pool: Pool;
let api: TestApi;

const ANCHOR = '2026-08-20T00:00:00Z';
const LEAGUE = 'league-lck';
const OTHER_LEAGUE = 'league-lec';
const TEAM_A = 'team-a';
const TEAM_B = 'team-b';

beforeAll(async () => {
  pool = await setupTestDb();
  api = await startApi(pool);
});

afterAll(async () => {
  await api.close();
  await pool.end();
});

beforeEach(async () => {
  await truncateAll(pool);
  await seed();
});

/** Three LCK matches an hour apart, plus one LEC match, all with the external_ref the overview needs. */
async function seed(): Promise<void> {
  await pool.query(`INSERT INTO game (id, slug, name) VALUES ('lol', 'lol', 'League of Legends')`);
  await pool.query(
    `INSERT INTO source (id, slug, name, organizer, base_url)
     VALUES ('riot-rest-lol', 'riot-rest-lol', 'Riot REST', 'Riot', 'https://example.invalid')`,
  );
  await pool.query(
    `INSERT INTO league (id, game_id, slug, name, tier, kind) VALUES
       ($1, 'lol', 'lck', 'LCK', 'major', 'region'),
       ($2, 'lol', 'lec', 'LEC', 'major', 'region'),
       ('league-minor', 'lol', 'ewc_lol', 'EWC', 'minor', 'event')`,
    [LEAGUE, OTHER_LEAGUE],
  );
  await pool.query(
    `INSERT INTO team (id, game_id, name, code) VALUES ($1, 'lol', 'Team A', 'TA'), ($2, 'lol', 'Team B', 'TB')`,
    [TEAM_A, TEAM_B],
  );

  const rows: [string, string, string][] = [
    ['m1', '2026-08-20T08:00:00Z', LEAGUE],
    ['m2', '2026-08-20T09:00:00Z', LEAGUE],
    ['m3', '2026-08-20T10:00:00Z', LEAGUE],
    ['m-lec', '2026-08-20T11:00:00Z', OTHER_LEAGUE],
  ];
  for (const [id, startsAt, leagueId] of rows) {
    await pool.query(
      `INSERT INTO match (id, league_id, starts_at_utc, best_of, games_played, block_name, state)
       VALUES ($1, $2, $3, 3, 0, 'Week 11', 'unstarted')`,
      [id, leagueId, startsAt],
    );
    await pool.query(
      `INSERT INTO match_team (match_id, side_index, team_id) VALUES ($1, 0, $2), ($1, 1, $3)`,
      [id, leagueId === LEAGUE ? TEAM_A : TEAM_B, TEAM_B],
    );
    await pool.query(
      `INSERT INTO external_ref (entity_type, entity_id, source_id, game_id, external_id)
       VALUES ('match', $1, 'riot-rest-lol', 'lol', $2)`,
      [id, `ext-${id}`],
    );
  }

  // One finished match with a real 2-0 result, in the past relative to ANCHOR.
  //
  // The seed was entirely `unstarted` until stage 2b's review, which is precisely why nothing here
  // exercised the spoiler question — a suite that only ever sees `score: null` cannot notice what
  // the API does with a score that exists.
  await pool.query(
    `INSERT INTO match (id, league_id, starts_at_utc, best_of, games_played, block_name, state)
     VALUES ('m-done', $1, '2026-08-19T08:00:00Z', 3, 2, 'Week 10', 'completed')`,
    [LEAGUE],
  );
  await pool.query(
    `INSERT INTO match_team (match_id, side_index, team_id, score)
     VALUES ('m-done', 0, $1, 2), ('m-done', 1, $2, 0)`,
    [TEAM_A, TEAM_B],
  );
  await pool.query(
    `INSERT INTO external_ref (entity_type, entity_id, source_id, game_id, external_id)
     VALUES ('match', 'm-done', 'riot-rest-lol', 'lol', 'ext-m-done')`,
  );
}

interface ApiMatch {
  id: string;
  state: string;
  seriesLength: number | null;
  gamesPlayed: number;
  sides: { team: { id: string } | null; score: number | null }[];
}

async function newUser(): Promise<{ userId: string; token: string }> {
  const res = await call(api, 'POST', '/v1/anon-users');
  expect(res.status).toBe(201);
  return res.body as { userId: string; token: string };
}

/** Row counts for every table a read must not touch. */
async function rowCounts(): Promise<Record<string, number>> {
  const tables = ['follow', 'selection', 'app_user', 'user_token', 'match', 'match_team', 'league', 'team'];
  const out: Record<string, number> = {};
  for (const t of tables) {
    const { rows } = await pool.query<{ count: string }>(`SELECT count(*)::text FROM ${t}`);
    out[t] = Number(rows[0]?.count ?? '0');
  }
  return out;
}

// ---------------------------------------------------------------------------

describe('identity', () => {
  it('issues a user and a token, and the token is not the id', async () => {
    const { userId, token } = await newUser();
    expect(token).not.toBe(userId);
    expect(token.length).toBeGreaterThanOrEqual(43);

    const me = await call(api, 'GET', '/v1/me', { token });
    expect(me.status).toBe(200);
    expect(me.body).toEqual({ userId });
  });

  it('is the only response that ever contains a token', async () => {
    const { token } = await newUser();
    for (const path of ['/v1/me', '/v1/me/follows', '/v1/me/selections']) {
      const res = await call(api, 'GET', path, { token });
      expect(res.raw).not.toContain(token);
    }
  });
});

describe('token rejection is uniform — SPEC §8 stage 2b', () => {
  it('answers identically for absent, malformed, wrong-scheme and unknown tokens', async () => {
    const { token } = await newUser();

    const responses = [
      await call(api, 'GET', '/v1/me'),
      await call(api, 'GET', '/v1/me', { headers: { authorization: '' } }),
      await call(api, 'GET', '/v1/me', { headers: { authorization: 'Basic abc' } }),
      await call(api, 'GET', '/v1/me', { headers: { authorization: 'Bearer' } }),
      await call(api, 'GET', '/v1/me', { token: 'not-a-real-token' }),
      await call(api, 'GET', '/v1/me', { token: `${token}x` }),
    ];

    for (const res of responses) {
      expect(res.status).toBe(401);
      // Byte-identical: a caller must not be able to tell a token that exists from one that does
      // not, or the credentials become enumerable.
      expect(res.raw).toBe(responses[0]?.raw);
    }
  });

  it('guards every route in the my-calendar group', async () => {
    const routes: [string, string][] = [
      ['GET', '/v1/me'],
      ['GET', '/v1/me/follows'],
      ['POST', '/v1/me/follows'],
      ['DELETE', '/v1/me/follows/league/x'],
      ['GET', '/v1/me/selections'],
      ['PUT', '/v1/me/selections/m1'],
      ['DELETE', '/v1/me/selections/m1'],
      ['GET', `/v1/me/calendar?anchor=${ANCHOR}`],
    ];
    for (const [method, path] of routes) {
      const res = await call(api, method, path, { body: method === 'GET' ? undefined : {} });
      expect({ path, status: res.status }).toEqual({ path, status: 401 });
    }
  });

  it('leaves the overview public', async () => {
    const res = await call(api, 'GET', `/v1/matches?anchor=${ANCHOR}`);
    expect(res.status).toBe(200);
  });
});

describe('the overview — FR-2', () => {
  it('returns matches in the domain shape, ascending, with no fabricated end time', async () => {
    const res = await call(api, 'GET', `/v1/matches?anchor=${ANCHOR}&direction=forward&limit=10`);
    expect(res.status).toBe(200);
    const body = res.body as { matches: { id: string; startsAtUtc: string }[]; nextCursor: string | null };
    expect(body.matches.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm-lec']);
    expect(body.matches[0]).not.toHaveProperty('endsAtUtc');
    expect(body.nextCursor).toBeNull();
  });

  it('round-trips its cursor over the wire', async () => {
    const first = await call(api, 'GET', `/v1/matches?anchor=${ANCHOR}&limit=2`);
    const firstBody = first.body as { matches: { id: string }[]; nextCursor: string };
    expect(firstBody.matches.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(typeof firstBody.nextCursor).toBe('string');

    const second = await call(
      api,
      'GET',
      `/v1/matches?anchor=${ANCHOR}&limit=2&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
    );
    expect((second.body as { matches: { id: string }[] }).matches.map((m) => m.id)).toEqual(['m3', 'm-lec']);
  });

  it('applying a filter issues no write', async () => {
    // Asserted against the database, not against the response: FR-2's distinction between a filter
    // (view state) and a follow (stored data) is only real if filtering provably writes nothing.
    const before = await rowCounts();

    await call(api, 'GET', `/v1/matches?anchor=${ANCHOR}&league=${LEAGUE}`);
    await call(api, 'GET', `/v1/matches?anchor=${ANCHOR}&team=${TEAM_A}`);
    await call(api, 'GET', `/v1/matches?anchor=${ANCHOR}&league=${LEAGUE}&league=${OTHER_LEAGUE}`);
    await call(api, 'GET', '/v1/leagues');

    expect(await rowCounts()).toEqual(before);
  });

  it('filters by league, by team, and by several leagues at once', async () => {
    const byLeague = await call(api, 'GET', `/v1/matches?anchor=${ANCHOR}&league=${LEAGUE}`);
    expect((byLeague.body as { matches: { id: string }[] }).matches.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);

    const byTeam = await call(api, 'GET', `/v1/matches?anchor=${ANCHOR}&team=${TEAM_A}`);
    expect((byTeam.body as { matches: { id: string }[] }).matches.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);

    const both = await call(api, 'GET', `/v1/matches?anchor=${ANCHOR}&league=${LEAGUE}&league=${OTHER_LEAGUE}`);
    expect((both.body as { matches: { id: string }[] }).matches).toHaveLength(4);
  });

  it('lists the covered leagues, excluding an explicitly minor one', async () => {
    const res = await call(api, 'GET', '/v1/leagues');
    const slugs = (res.body as { leagues: { slug: string }[] }).leagues.map((l) => l.slug);
    expect(slugs).toEqual(['lck', 'lec']);
  });
});

describe('spoilers: the API ships scores, the client masks them', () => {
  /**
   * Pins a decision, not a discovery. Owner's decision 2026-08-17: the API carries `score` and
   * `gamesPlayed` unconditionally and masking is the client's obligation, keyed on `state`
   * (CLAUDE.md's non-negotiable list; SPEC §2 FR-3; the client contract in docs/API.md).
   *
   * These assertions are deliberately the "wrong" way round — they assert a public endpoint *does*
   * emit a completed match's score. A code review read exactly that as a defect. If someone later
   * strips it as a fix, this turns red and points them at the decision instead of letting a
   * three-client contract change silently.
   */
  it('returns a completed match with its real score on the public endpoint', async () => {
    const res = await call(api, 'GET', '/v1/matches?anchor=2026-08-19T00:00:00Z&limit=10');
    const done = (res.body as { matches: ApiMatch[] }).matches.find((m) => m.id === 'm-done');
    if (done === undefined) throw new Error('expected the completed match in the page');

    expect(done.state).toBe('completed');
    expect(done.sides.map((s) => s.score)).toEqual([2, 0]);
    // gamesPlayed leaks a sweep on its own — 2 of a Bo3 is 2-0 — so the client contract names it
    // alongside score. It is shipped for the same reason and masked by the same condition.
    expect(done.gamesPlayed).toBe(2);
    expect(done.seriesLength).toBe(3);
  });

  it('gives every match a state the mask condition can branch on', async () => {
    // `state` is the mask key, so it may never be absent, null, or an unrecognised value on any
    // match — a client that cannot evaluate the condition has to choose between leaking a result
    // and hiding one that was never a spoiler. Asserted over the whole page rather than over one
    // match, and against the closed enum rather than `typeof`, so a null from a future LEFT JOIN
    // is caught instead of passing because some other row happened to be fine.
    const res = await call(api, 'GET', '/v1/matches?anchor=2026-08-19T00:00:00Z&limit=10');
    const matches = (res.body as { matches: ApiMatch[] }).matches;
    expect(matches.length).toBeGreaterThan(1);
    for (const m of matches) {
      expect(['unstarted', 'inProgress', 'completed', 'cancelled']).toContain(m.state);
    }
  });

  it('carries them on the calendar too, which is the surface stage 3 renders', async () => {
    const { token } = await newUser();
    await call(api, 'POST', '/v1/me/follows', { token, body: { targetType: 'league', targetId: LEAGUE } });

    const res = await call(api, 'GET', '/v1/me/calendar?anchor=2026-08-19T00:00:00Z&limit=10', { token });
    const done = (res.body as { matches: ApiMatch[] }).matches.find((m) => m.id === 'm-done');
    expect(done?.sides.map((s) => s.score)).toEqual([2, 0]);
  });

  it('has no spoiler parameter, and an unknown one does not silently change the answer', async () => {
    // Guards against a client author assuming `?spoilers=false` exists and being quietly ignored.
    // zod's object schemas strip unknown keys rather than rejecting, so the request succeeds — the
    // point of the assertion is that it succeeds *with the scores still present*, so a client
    // relying on a parameter that does not exist fails visibly in its own tests, not in production.
    const res = await call(api, 'GET', '/v1/matches?anchor=2026-08-19T00:00:00Z&limit=10&spoilers=false');
    const done = (res.body as { matches: ApiMatch[] }).matches.find((m) => m.id === 'm-done');
    expect(done?.sides.map((s) => s.score)).toEqual([2, 0]);
  });
});

describe('follows and selections over HTTP', () => {
  it('follows, lists, and unfollows', async () => {
    const { token } = await newUser();

    const created = await call(api, 'POST', '/v1/me/follows', {
      token,
      body: { targetType: 'league', targetId: LEAGUE },
    });
    expect(created.status).toBe(201);

    // Idempotent: the same follow again is 200, not a 409 — a client retrying a dropped request
    // has not done anything wrong.
    const again = await call(api, 'POST', '/v1/me/follows', {
      token,
      body: { targetType: 'league', targetId: LEAGUE },
    });
    expect(again.status).toBe(200);

    const listed = await call(api, 'GET', '/v1/me/follows', { token });
    expect(listed.body).toEqual({ follows: [{ targetType: 'league', targetId: LEAGUE }] });

    const removed = await call(api, 'DELETE', `/v1/me/follows/league/${LEAGUE}`, { token });
    expect(removed.status).toBe(204);
    expect(await call(api, 'GET', '/v1/me/follows', { token }).then((r) => r.body)).toEqual({ follows: [] });
  });

  it('unfollowing over HTTP does not delete a pick — FR-1 rule 3', async () => {
    const { token } = await newUser();
    await call(api, 'POST', '/v1/me/follows', { token, body: { targetType: 'team', targetId: TEAM_A } });
    await call(api, 'PUT', '/v1/me/selections/m1', { token, body: { state: 'included' } });

    await call(api, 'DELETE', `/v1/me/follows/team/${TEAM_A}`, { token });

    const selections = await call(api, 'GET', '/v1/me/selections', { token });
    expect(selections.body).toEqual({ selections: [{ matchId: 'm1', state: 'included' }] });
  });

  it('distinguishes excluding a match from clearing the statement', async () => {
    const { token } = await newUser();
    await call(api, 'PUT', '/v1/me/selections/m1', { token, body: { state: 'excluded' } });
    expect(await call(api, 'GET', '/v1/me/selections', { token }).then((r) => r.body)).toEqual({
      selections: [{ matchId: 'm1', state: 'excluded' }],
    });

    const cleared = await call(api, 'DELETE', '/v1/me/selections/m1', { token });
    expect(cleared.status).toBe(204);
    expect(await call(api, 'GET', '/v1/me/selections', { token }).then((r) => r.body)).toEqual({ selections: [] });
  });
});

describe('the calendar', () => {
  it('composes follows and selections — a followed league minus one match', async () => {
    const { token } = await newUser();
    await call(api, 'POST', '/v1/me/follows', { token, body: { targetType: 'league', targetId: LEAGUE } });
    await call(api, 'PUT', '/v1/me/selections/m2', { token, body: { state: 'excluded' } });

    const res = await call(api, 'GET', `/v1/me/calendar?anchor=${ANCHOR}&limit=10`, { token });
    expect((res.body as { matches: { id: string }[] }).matches.map((m) => m.id)).toEqual(['m1', 'm3']);
  });

  it('adds a match no follow covers when it is explicitly included', async () => {
    const { token } = await newUser();
    await call(api, 'PUT', '/v1/me/selections/m-lec', { token, body: { state: 'included' } });

    const res = await call(api, 'GET', `/v1/me/calendar?anchor=${ANCHOR}&limit=10`, { token });
    expect((res.body as { matches: { id: string }[] }).matches.map((m) => m.id)).toEqual(['m-lec']);
  });

  it('is empty for a user who has done nothing', async () => {
    const { token } = await newUser();
    const res = await call(api, 'GET', `/v1/me/calendar?anchor=${ANCHOR}&limit=10`, { token });
    expect((res.body as { matches: unknown[] }).matches).toEqual([]);
  });
});

describe('one user cannot see or touch another', () => {
  it('scopes every my-calendar read to the bearer of the token', async () => {
    const alice = await newUser();
    const bob = await newUser();

    await call(api, 'POST', '/v1/me/follows', {
      token: alice.token,
      body: { targetType: 'league', targetId: LEAGUE },
    });
    await call(api, 'PUT', '/v1/me/selections/m1', { token: alice.token, body: { state: 'excluded' } });

    expect(await call(api, 'GET', '/v1/me/follows', { token: bob.token }).then((r) => r.body)).toEqual({
      follows: [],
    });
    expect(await call(api, 'GET', '/v1/me/selections', { token: bob.token }).then((r) => r.body)).toEqual({
      selections: [],
    });
    expect(
      await call(api, 'GET', `/v1/me/calendar?anchor=${ANCHOR}`, { token: bob.token }).then(
        (r) => (r.body as { matches: unknown[] }).matches,
      ),
    ).toEqual([]);
  });

  it("bob's write does not reach alice's rows", async () => {
    const alice = await newUser();
    const bob = await newUser();

    await call(api, 'PUT', '/v1/me/selections/m1', { token: alice.token, body: { state: 'included' } });
    await call(api, 'PUT', '/v1/me/selections/m1', { token: bob.token, body: { state: 'excluded' } });

    expect(await call(api, 'GET', '/v1/me/selections', { token: alice.token }).then((r) => r.body)).toEqual({
      selections: [{ matchId: 'm1', state: 'included' }],
    });
  });
});

describe('bad input is a 400, never a 500', () => {
  const cases: [string, string][] = [
    ['a missing anchor', '/v1/matches'],
    ['an anchor with no zone marker', '/v1/matches?anchor=2026-08-20T00:00:00'],
    ['a non-numeric limit', `/v1/matches?anchor=${ANCHOR}&limit=abc`],
    ['a limit above the cap', `/v1/matches?anchor=${ANCHOR}&limit=100000`],
    ['a limit of zero', `/v1/matches?anchor=${ANCHOR}&limit=0`],
    ['an unknown direction', `/v1/matches?anchor=${ANCHOR}&direction=sideways`],
    ['a corrupt cursor', `/v1/matches?anchor=${ANCHOR}&cursor=%%%not-base64%%%`],
    ['a cursor of the wrong shape', `/v1/matches?anchor=${ANCHOR}&cursor=${Buffer.from('{"a":1}').toString('base64url')}`],
  ];

  it.each(cases)('rejects %s', async (_label, path) => {
    const res = await call(api, 'GET', path);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: 'bad_request' } });
  });

  it('rejects a selection state outside the enum', async () => {
    const { token } = await newUser();
    const res = await call(api, 'PUT', '/v1/me/selections/m1', { token, body: { state: 'maybe' } });
    expect(res.status).toBe(400);
  });

  it('rejects a follow target type outside the enum', async () => {
    const { token } = await newUser();
    const res = await call(api, 'POST', '/v1/me/follows', { token, body: { targetType: 'player', targetId: 'x' } });
    expect(res.status).toBe(400);
  });

  it('answers an unrouted path with the same error shape', async () => {
    const res = await call(api, 'GET', '/v1/nope');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: { code: 'not_found' } });
  });
});
