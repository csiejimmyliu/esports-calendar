import { describe, expect, it } from 'vitest';
import {
  createRiotRestLolAdapter,
  fixtureTransport,
  GLOBAL_SCOPE,
  MAX_SCHEDULE_PAGES,
  regionalLeaguesPresent,
  scheduleHasUpcoming,
} from '../src/sources/riot/rest/adapter.js';
import type { RiotRestTransport } from '../src/sources/riot/rest/adapter.js';
import { FIXTURE_CAPTURED_AT, loadCrawlFixture, loadFixture, realLeagueConfig } from './fixtures.js';

const schedule = loadFixture('riot-lol/rest_getSchedule.json');
const leagues = loadFixture('riot-lol/rest_getLeagues.json');
const teams = loadFixture('riot-lol/rest_getTeams.json');
const crawlPages = loadCrawlFixture('riot-lol/rest_getSchedule_crawl_2026-08-12');
const now = new Date(FIXTURE_CAPTURED_AT);

function adapter(transport: RiotRestTransport = fixtureTransport({ schedule, leagues, teams })) {
  return createRiotRestLolAdapter(transport, realLeagueConfig());
}

/**
 * Some tests below build a raw `RiotRestTransport` double directly rather than through
 * `fixtureTransport`, to control getLeagues/getTeams independently of getSchedule. Their
 * `getSchedule` used to ignore the pageToken argument and return `schedule` unconditionally —
 * harmless before Stage 0.7, but `schedule`'s own `pages.newer` is genuinely non-null
 * (rest_getSchedule.json was captured mid-crawl), so an unmodified double now looks like an
 * infinite repeat of the same page to the crawl loop. This clone expresses what the double always
 * meant — "this is the only page" — now that pagination exists to disagree with.
 */
function terminalSchedule(raw: unknown): unknown {
  const doc = JSON.parse(JSON.stringify(raw)) as {
    data: { schedule: { pages?: { newer: string | null } } };
  };
  if (doc.data.schedule.pages) doc.data.schedule.pages.newer = null;
  return doc;
}

describe('capabilities are declared honestly', () => {
  const caps = adapter().capabilities;

  it('declares that it can identify teams, which describes the adapter and not getSchedule', () => {
    // getSchedule still has no team ids. The adapter joins getTeams, and the capability describes
    // what the adapter can deliver — which is what the sync layer branches on for FR-1.
    expect(caps.teamIdentity).toBe(true);
  });

  it('declares no stream URLs, as a settled answer rather than a pending probe', () => {
    expect(caps.streamUrls).toBe(false);
  });

  it('declares its single scope as implicit, not as something it discovered', () => {
    expect(caps.scopeDiscovery).toBe('implicit');
  });

  it('declares state as inferred, even though the endpoint has a state field', () => {
    // The field exists and is untrustworthy for undecided matches, so the adapter derives the
    // value from `result`. A capability describes what we can rely on, not what was returned.
    expect(caps.explicitState).toBe(false);
  });

  it('does not claim a time window it does not honour', async () => {
    /**
     * fetchMatches crawls the whole forward horizon (Stage 0.7) rather than narrowing to one —
     * the opposite of what `timeWindow: true` would mean, and a `window` argument is still
     * ignored outright. See the `timeWindow` comment in adapter.ts.
     *
     * The assertion is deliberately two-sided rather than `toBe(false)` — it pins the *agreement*
     * between the flag and the behaviour, so implementing a bounded crawl and flipping the flag
     * passes, while flipping the flag alone fails.
     */
    const narrow = { fromUtc: '2026-08-09T00:00:00Z', toUtc: '2026-08-09T23:59:59Z' };
    const windowed = await adapter().fetchMatches(GLOBAL_SCOPE, narrow);
    const unwindowed = await adapter().fetchMatches(GLOBAL_SCOPE);
    const honoursWindow = windowed.items.length < unwindowed.items.length;
    expect(caps.timeWindow).toBe(honoursWindow);
  });
});

describe('listScopes', () => {
  it('returns one global scope without spending a request', async () => {
    const result = await adapter().listScopes();
    expect(result.items).toEqual([GLOBAL_SCOPE]);
    expect(result.diagnostics.requestCount).toBe(0);
  });
});

describe('fetchMatches hides its multi-request shape but not its cost', () => {
  it('reports three upstream requests for one result', async () => {
    // getSchedule + getLeagues + getTeams. The sync layer learns the count, never the endpoints —
    // the same arrangement BLAST would need for /matches + /brackets (NFR-3).
    const result = await adapter().fetchMatches(GLOBAL_SCOPE);
    expect(result.diagnostics.requestCount).toBe(3);
    expect(result.items).toHaveLength(80);
  });

  it('calls getTeams once per fetch, not once per match', async () => {
    let calls = 0;
    const counted: RiotRestTransport = {
      getSchedule: () => Promise.resolve({ json: terminalSchedule(schedule), bytes: 0 }),
      getLeagues: () => Promise.resolve({ json: leagues, bytes: 0 }),
      getTeams: () => {
        calls += 1;
        return Promise.resolve({ json: teams, bytes: 0 });
      },
    };
    const result = await adapter(counted).fetchMatches(GLOBAL_SCOPE);
    expect(result.items).toHaveLength(80);
    expect(calls).toBe(1);
  });

  it('still returns every match when the secondary request fails, and says it degraded', async () => {
    const degraded: RiotRestTransport = {
      getSchedule: () => Promise.resolve({ json: terminalSchedule(schedule), bytes: 0 }),
      getLeagues: () => Promise.reject(new Error('503')),
      getTeams: () => Promise.resolve({ json: teams, bytes: 0 }),
    };
    const result = await adapter(degraded).fetchMatches(GLOBAL_SCOPE);

    expect(result.items).toHaveLength(80);
    expect(result.items.every((m) => m.leagueExternalId === null)).toBe(true);
    expect(result.items.every((m) => m.leagueSlug !== null)).toBe(true);
    expect(result.warnings.map((w) => w.code)).toContain('degraded-fetch');
    // Team identity goes down with it: getTeams' only link to a league is a localized display
    // name, and getLeagues is what translates a major slug into one.
    expect(result.warnings.map((w) => w.code)).toContain('no-team-identity');
    expect(result.items.every((m) => m.sides.every((s) => s.team?.externalId == null))).toBe(true);
    expect(result.diagnostics.requestCount).toBe(1);
  });

  it('reports no-team-identity when getTeams itself fails, not only when getLeagues does', async () => {
    // Stage 1b: this branch used to warn only `degraded-fetch`. `no-team-identity` is what
    // src/sync/ingest.ts's A1 fix (preserve, don't overwrite, a previously resolved team id)
    // relies on being able to tell apart from other degraded-fetch causes without inspecting the
    // message text.
    const degradedTeams: RiotRestTransport = {
      getSchedule: () => Promise.resolve({ json: terminalSchedule(schedule), bytes: 0 }),
      getLeagues: () => Promise.resolve({ json: leagues, bytes: 0 }),
      getTeams: () => Promise.reject(new Error('503')),
    };
    const result = await adapter(degradedTeams).fetchMatches(GLOBAL_SCOPE);

    expect(result.items).toHaveLength(80);
    expect(result.warnings.map((w) => w.code)).toContain('degraded-fetch');
    expect(result.warnings.map((w) => w.code)).toContain('no-team-identity');
    expect(result.items.every((m) => m.sides.every((s) => s.team?.externalId == null))).toBe(true);
  });

  it('propagates a primary failure instead of reporting a successful empty fetch', async () => {
    const broken: RiotRestTransport = {
      getSchedule: () => Promise.reject(new Error('upstream down')),
      getLeagues: () => Promise.resolve({ json: leagues, bytes: 0 }),
      getTeams: () => Promise.resolve({ json: teams, bytes: 0 }),
    };
    await expect(adapter(broken).fetchMatches(GLOBAL_SCOPE)).rejects.toThrow('upstream down');
  });
});

describe('canaries assert content, and survive an off-season', () => {
  const regional = regionalLeaguesPresent(realLeagueConfig());

  it('exposes both canaries on the adapter', () => {
    expect(adapter().canaries.map((c) => c.key)).toEqual([
      'regional-leagues-present',
      'schedule-has-upcoming',
    ]);
  });

  describe('regional-leagues-present', () => {
    it('passes against the captured response', async () => {
      const result = await adapter().fetchMatches(GLOBAL_SCOPE);
      expect(regional.check(result.items, now)).toEqual({
        ok: true,
        detail: 'all 5 regional leagues present',
      });
    });

    it('does not require the international events to have any matches', async () => {
      /**
       * This is the whole reason the canary was rewritten. Worlds, MSI and First Stand are covered
       * majors with **zero** matches in the capture, which is their normal state for most of the
       * year. The previous canary shape — "league X has a match in the next 14 days" — fires every
       * off-season, and a canary that cries wolf on schedule gets muted.
       */
      const result = await adapter().fetchMatches(GLOBAL_SCOPE);
      const events = ['worlds', 'msi', 'first_stand'];
      expect(result.items.filter((m) => events.includes(m.leagueSlug ?? ''))).toHaveLength(0);
      expect(regional.check(result.items, now).ok).toBe(true);
    });

    it('fails when one covered league silently disappears', async () => {
      // A global row count stays healthy while one league vanishes — a rename upstream, or a typo
      // in config/leagues.json. This is why the canary asserts content and not "did we get rows".
      const result = await adapter().fetchMatches(GLOBAL_SCOPE);
      const withoutLck = result.items.filter((m) => m.leagueSlug !== 'lck');
      expect(withoutLck.length).toBeGreaterThan(50);
      expect(regional.check(withoutLck, now)).toEqual({ ok: false, detail: 'absent from the feed: lck' });
    });

    it('fails on an empty parse — the case an HTTP check cannot see', () => {
      expect(regional.check([], now).ok).toBe(false);
    });
  });

  describe('schedule-has-upcoming', () => {
    it('passes against the captured response at its capture time', async () => {
      const result = await adapter().fetchMatches(GLOBAL_SCOPE);
      expect(scheduleHasUpcoming.check(result.items, now)).toEqual({
        ok: true,
        detail: expect.stringContaining('match(es) in the next 14 days'),
      });
    });

    it('fails when the feed carries only stale rows', async () => {
      // Every league still present, plenty of rows, nothing ahead. A per-league presence check
      // cannot see this, which is why the two canaries are separate assertions.
      const result = await adapter().fetchMatches(GLOBAL_SCOPE);
      const onlyPast = result.items.filter((m) => new Date(m.startsAtUtc).getTime() < now.getTime());
      expect(onlyPast.length).toBeGreaterThan(20);
      expect(regional.check(onlyPast, now).ok).toBe(true);
      expect(scheduleHasUpcoming.check(onlyPast, now).ok).toBe(false);
    });

    it('fails on an empty parse', () => {
      expect(scheduleHasUpcoming.check([], now).ok).toBe(false);
    });
  });
});

describe('fetchMatches crawls the schedule to exhaustion', () => {
  function crawlAdapter(transport?: RiotRestTransport) {
    return createRiotRestLolAdapter(
      transport ?? fixtureTransport({ schedule: crawlPages, leagues, teams }),
      realLeagueConfig(),
    );
  }

  it('follows pages.newer until it is null', async () => {
    const result = await crawlAdapter().fetchMatches(GLOBAL_SCOPE);
    // 6 schedule pages + getLeagues + getTeams.
    expect(result.diagnostics.requestCount).toBe(8);
    expect(result.diagnostics.pagesFetched).toBe(6);
    expect(result.diagnostics.crawlComplete).toBe(true);
    expect(result.items).toHaveLength(436);
    expect(result.warnings.map((w) => w.code)).not.toContain('crawl-incomplete');
  });

  it('returns the pages it got when a middle page fails, and says the horizon is short', async () => {
    let call = 0;
    const flaky: RiotRestTransport = {
      getSchedule: () => {
        call += 1;
        if (call === 3) return Promise.reject(new Error('503 on page 3'));
        return Promise.resolve({ json: crawlPages[call - 1], bytes: 0 });
      },
      getLeagues: () => Promise.resolve({ json: leagues, bytes: 0 }),
      getTeams: () => Promise.resolve({ json: teams, bytes: 0 }),
    };

    const result = await crawlAdapter(flaky).fetchMatches(GLOBAL_SCOPE);

    // Pages 1-2 succeeded (80 + 80 events); nothing is thrown away.
    expect(result.items).toHaveLength(160);
    expect(result.diagnostics.pagesFetched).toBe(2);
    expect(result.diagnostics.crawlComplete).toBe(false);
    expect(result.warnings.map((w) => w.code)).toContain('crawl-incomplete');

    // horizonUtc is a fact about what actually came back, not an independently hardcoded date —
    // it must be the latest start time among the matches the caller actually receives.
    const latestReturned = [...result.items].map((m) => m.startsAtUtc).sort().at(-1);
    expect(result.diagnostics.horizonUtc).toBe(latestReturned);
  });

  it('still throws when the first page fails', async () => {
    const broken: RiotRestTransport = {
      getSchedule: () => Promise.reject(new Error('upstream down')),
      getLeagues: () => Promise.resolve({ json: leagues, bytes: 0 }),
      getTeams: () => Promise.resolve({ json: teams, bytes: 0 }),
    };
    await expect(crawlAdapter(broken).fetchMatches(GLOBAL_SCOPE)).rejects.toThrow('upstream down');
  });

  it('stops and reports when a page repeats a token it has already sent', async () => {
    // A schedule that always hands back the same "newer" token, however many times it is asked —
    // the pathological case the repeated-token guard exists to bound.
    const loopingPage = (): unknown => ({
      data: {
        schedule: {
          pages: { older: null, newer: 'bmV3ZXI6OjE=' },
          events: [],
        },
      },
    });
    const looping: RiotRestTransport = {
      getSchedule: () => Promise.resolve({ json: loopingPage(), bytes: 0 }),
      getLeagues: () => Promise.resolve({ json: leagues, bytes: 0 }),
      getTeams: () => Promise.resolve({ json: teams, bytes: 0 }),
    };

    const result = await crawlAdapter(looping).fetchMatches(GLOBAL_SCOPE);

    expect(result.diagnostics.crawlComplete).toBe(false);
    // Page 1 establishes the token; page 2 repeats it and the crawl stops there.
    expect(result.diagnostics.pagesFetched).toBe(2);
    const warning = result.warnings.find((w) => w.code === 'crawl-incomplete');
    expect(warning?.message).toContain('repeat');
  });

  it('stops and reports at the page cap rather than crawling forever', async () => {
    // A schedule that always advances to a fresh, never-before-seen token — the guard that must
    // catch this is the page cap, not the repeated-token check.
    let n = 0;
    const neverTerminating: RiotRestTransport = {
      getSchedule: () => {
        n += 1;
        return Promise.resolve({
          json: {
            data: {
              schedule: {
                pages: { older: null, newer: `bmV3ZXI6OiR7bn0=${String(n)}` },
                events: [],
              },
            },
          },
          bytes: 0,
        });
      },
      getLeagues: () => Promise.resolve({ json: leagues, bytes: 0 }),
      getTeams: () => Promise.resolve({ json: teams, bytes: 0 }),
    };

    const result = await crawlAdapter(neverTerminating).fetchMatches(GLOBAL_SCOPE);

    expect(result.diagnostics.crawlComplete).toBe(false);
    expect(result.diagnostics.pagesFetched).toBe(MAX_SCHEDULE_PAGES);
    const warning = result.warnings.find((w) => w.code === 'crawl-incomplete');
    expect(warning?.message).toContain('cap');
  });

  it('ignores the window argument entirely, and spends the same requests either way', async () => {
    const narrow = { fromUtc: '2026-08-12T00:00:00Z', toUtc: '2026-08-12T23:59:59Z' };
    const a = await crawlAdapter().fetchMatches(GLOBAL_SCOPE, narrow);
    const b = await crawlAdapter().fetchMatches(GLOBAL_SCOPE);
    expect(a.diagnostics.requestCount).toBe(b.diagnostics.requestCount);
    expect(a.items.length).toBe(b.items.length);
  });
});
