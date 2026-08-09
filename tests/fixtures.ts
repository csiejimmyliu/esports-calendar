import { readFileSync } from 'node:fs';

export function loadFixture(relativePath: string): unknown {
  return JSON.parse(readFileSync(new URL(`../fixtures/${relativePath}`, import.meta.url), 'utf8'));
}

/** The instant `fixtures/riot-lol/*` was captured. Every fixture-backed test pins to this. */
export const FIXTURE_CAPTURED_AT = '2026-08-09T00:00:00Z';

/** Build a getSchedule envelope around arbitrary events, for the synthetic edge cases. */
export function scheduleEnvelope(events: unknown[]): unknown {
  return { data: { schedule: { pages: { older: null, newer: null }, events } } };
}

export function matchEvent(overrides: Record<string, unknown> = {}): unknown {
  return {
    startTime: '2026-08-09T08:00:00Z',
    state: 'unstarted',
    type: 'match',
    blockName: 'Week 11',
    league: { name: 'LCK', slug: 'lck' },
    match: {
      id: '900000000000000001',
      flags: [],
      strategy: { type: 'bestOf', count: 3 },
      teams: [
        { name: 'Alpha', code: 'ALP', image: 'http://static.lolesports.com/teams/a.png', result: { outcome: null, gameWins: 0 } },
        { name: 'Beta', code: 'BET', image: 'http://static.lolesports.com/teams/b.png', result: { outcome: null, gameWins: 0 } },
      ],
    },
    ...overrides,
  };
}
