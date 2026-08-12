import { readdirSync, readFileSync } from 'node:fs';

import { createLeagueConfig } from '../src/config/leagues.js';
import type { LeagueConfig } from '../src/config/leagues.js';

export function loadFixture(relativePath: string): unknown {
  return JSON.parse(readFileSync(new URL(`../fixtures/${relativePath}`, import.meta.url), 'utf8'));
}

/** The instant `fixtures/riot-lol/*` was captured. Every fixture-backed test pins to this. */
export const FIXTURE_CAPTURED_AT = '2026-08-09T00:00:00Z';

/**
 * The instant `fixtures/riot-lol/rest_getSchedule_crawl_2026-08-12/` was captured — three days
 * after FIXTURE_CAPTURED_AT, which is why it is a second constant rather than a moved one. Moving
 * the shared constant would break every relative-date assertion built on rest_getSchedule.json for
 * a reason unrelated to the code (CLAUDE.md: fixture-backed tests inject a fixed reference clock).
 */
export const CRAWL_FIXTURE_CAPTURED_AT = '2026-08-12T02:55:44.518Z';

/** Load a crawl fixture's pages in page order (page1, page2, … — numeric, not lexical). */
export function loadCrawlFixture(relativeDir: string): unknown[] {
  const dirUrl = new URL(`../fixtures/${relativeDir}/`, import.meta.url);
  const names = readdirSync(dirUrl)
    .filter((n) => /^page\d+\.json$/.exec(n))
    .sort((a, b) => Number(/^page(\d+)\.json$/.exec(a)?.[1]) - Number(/^page(\d+)\.json$/.exec(b)?.[1]));
  return names.map((n) => JSON.parse(readFileSync(new URL(n, dirUrl), 'utf8')));
}

/**
 * The real, shipped tier table. Tests that assert on real fixtures use this one, so that a change
 * to config/leagues.json which breaks resolution turns the build red instead of passing against a
 * private copy that agrees with the code.
 */
export function realLeagueConfig(): LeagueConfig {
  return createLeagueConfig(
    JSON.parse(readFileSync(new URL('../config/leagues.json', import.meta.url), 'utf8')),
  );
}

/**
 * A minimal tier table, for tests that are about the resolution rules and not about the file.
 *
 * Majors default to `kind: 'region'` **here, in the test helper only** — the production loader
 * refuses a major without an explicit kind, and that refusal is asserted separately. Defaulting in
 * the helper keeps rule tests to one line; defaulting in the loader would let an international event
 * quietly start contributing placeholder rows to the team table.
 */
export function testLeagueConfig(
  leagues: { slug: string; tier: 'major' | 'minor'; kind?: 'region' | 'event' }[],
  teamOverrides: { code: string; leagueSlug: string; teamId: string; reason: string }[] = [],
): LeagueConfig {
  return createLeagueConfig({
    leagues: leagues.map((l) =>
      l.tier === 'major' ? { kind: 'region' as const, ...l } : l,
    ),
    teamOverrides,
  });
}

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
