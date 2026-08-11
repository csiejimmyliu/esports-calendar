import { describe, expect, it } from 'vitest';
import {
  createRiotRestLolAdapter,
  fixtureTransport,
  GLOBAL_SCOPE,
  regionalLeaguesPresent,
  scheduleHasUpcoming,
} from '../src/sources/riot/rest/adapter.js';
import type { RiotRestTransport } from '../src/sources/riot/rest/adapter.js';
import { FIXTURE_CAPTURED_AT, loadFixture, realLeagueConfig } from './fixtures.js';

const schedule = loadFixture('riot-lol/rest_getSchedule.json');
const leagues = loadFixture('riot-lol/rest_getLeagues.json');
const teams = loadFixture('riot-lol/rest_getTeams.json');
const now = new Date(FIXTURE_CAPTURED_AT);

function adapter(transport: RiotRestTransport = fixtureTransport({ schedule, leagues, teams })) {
  return createRiotRestLolAdapter(transport, realLeagueConfig());
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
     * fetchMatches never sends a cursor, regardless of whether getSchedule's pagination could
     * support one end to end (unresolved — see the `timeWindow` comment in adapter.ts). A `true`
     * here would be a lie the sync layer branches on: it would ask for a range and silently
     * receive everything.
     *
     * The assertion is deliberately two-sided rather than `toBe(false)` — it pins the *agreement*
     * between the flag and the behaviour, so implementing cursors and flipping the flag passes,
     * while flipping the flag alone fails.
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
      getSchedule: () => Promise.resolve({ json: schedule, bytes: 0 }),
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
      getSchedule: () => Promise.resolve({ json: schedule, bytes: 0 }),
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
