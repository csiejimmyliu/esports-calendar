import { describe, expect, it } from 'vitest';
import {
  createRiotRestLolAdapter,
  fixtureTransport,
  GLOBAL_SCOPE,
  lckHasUpcoming,
} from '../src/sources/riot/rest/adapter.js';
import type { RiotRestTransport } from '../src/sources/riot/rest/adapter.js';
import { FIXTURE_CAPTURED_AT, loadFixture } from './fixtures.js';

const schedule = loadFixture('riot-lol/rest_getSchedule.json');
const leagues = loadFixture('riot-lol/rest_getLeagues.json');
const now = new Date(FIXTURE_CAPTURED_AT);

function adapter(transport: RiotRestTransport = fixtureTransport({ schedule, leagues })) {
  return createRiotRestLolAdapter(transport);
}

describe('capabilities are declared honestly', () => {
  const caps = adapter().capabilities;

  it('declares that it cannot identify teams', () => {
    // Not a cosmetic flag: a source with teamIdentity false cannot back team subscriptions
    // (FR-1), however complete its match rows look.
    expect(caps.teamIdentity).toBe(false);
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
});

describe('listScopes', () => {
  it('returns one global scope without spending a request', async () => {
    const result = await adapter().listScopes();
    expect(result.items).toEqual([GLOBAL_SCOPE]);
    expect(result.diagnostics.requestCount).toBe(0);
  });
});

describe('fetchMatches hides its multi-request shape but not its cost', () => {
  it('reports two upstream requests for one result', async () => {
    // getSchedule + getLeagues. The sync layer learns the count, never the endpoints — the same
    // arrangement BLAST will need for /matches + /brackets (NFR-3).
    const result = await adapter().fetchMatches(GLOBAL_SCOPE);
    expect(result.diagnostics.requestCount).toBe(2);
    expect(result.items).toHaveLength(80);
  });

  it('still returns every match when the secondary request fails, and says it degraded', async () => {
    const degraded: RiotRestTransport = {
      getSchedule: () => Promise.resolve({ json: schedule, bytes: 0 }),
      getLeagues: () => Promise.reject(new Error('503')),
    };
    const result = await adapter(degraded).fetchMatches(GLOBAL_SCOPE);

    expect(result.items).toHaveLength(80);
    expect(result.items.every((m) => m.leagueExternalId === null)).toBe(true);
    expect(result.items.every((m) => m.leagueSlug !== null)).toBe(true);
    expect(result.warnings.map((w) => w.code)).toContain('degraded-fetch');
    expect(result.diagnostics.requestCount).toBe(1);
  });

  it('propagates a primary failure instead of reporting a successful empty fetch', async () => {
    const broken: RiotRestTransport = {
      getSchedule: () => Promise.reject(new Error('upstream down')),
      getLeagues: () => Promise.resolve({ json: leagues, bytes: 0 }),
    };
    await expect(adapter(broken).fetchMatches(GLOBAL_SCOPE)).rejects.toThrow('upstream down');
  });
});

describe('the LCK canary', () => {
  it('passes against the captured response at its capture time', async () => {
    const result = await adapter().fetchMatches(GLOBAL_SCOPE);
    expect(lckHasUpcoming.check(result.items, now)).toEqual({
      ok: true,
      detail: expect.stringContaining('LCK match(es)'),
    });
  });

  it('fails on an empty parse — the case an HTTP check cannot see', async () => {
    expect(lckHasUpcoming.check([], now).ok).toBe(false);
  });

  it('fails when every league except LCK is present', async () => {
    // A global row count stays healthy while one league silently disappears. This is why the
    // canary asserts content and not "did we get any rows".
    const result = await adapter().fetchMatches(GLOBAL_SCOPE);
    const withoutLck = result.items.filter((m) => m.leagueSlug !== 'lck');
    expect(withoutLck.length).toBeGreaterThan(50);
    expect(lckHasUpcoming.check(withoutLck, now).ok).toBe(false);
  });
});
