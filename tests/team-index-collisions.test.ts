/**
 * Closes SPEC §9's open item: "the full getTeams capture exists only on the owner's machine."
 *
 * The join-key decision in the 2026-08-11 refactor (name over code — see
 * src/sources/riot/rest/teams.ts) rests on collision counts measured against the full 1568-row
 * `getTeams` response. Before fixtures/riot-lol/rest_getTeams_full.json existed, that response was
 * 1.5 MB and gitignored, so those figures were disclosed as unverifiable rather than checked —
 * and one of them was wrong for two days as a direct result (27 vs. the real 46, see
 * docs/sources/lolesports-rest.md and this repo's history) because nothing could catch it.
 *
 * This file re-derives every figure quoted in config/leagues.json and
 * fixtures/riot-lol/rest_getTeams.meta.json directly from the now-committed full fixture, so a
 * future edit that breaks one of them turns the build red instead of only a comment stale.
 */

import { describe, expect, it } from 'vitest';

import { parseLeagues } from '../src/sources/riot/rest/parse.js';
import { buildTeamIndex, normalizeTeamName, parseTeams } from '../src/sources/riot/rest/teams.js';
import type { RiotTeamRecord } from '../src/sources/riot/rest/teams.js';
import { loadFixture, realLeagueConfig } from './fixtures.js';

const fullTeamsRaw = loadFixture('riot-lol/rest_getTeams_full.json');
const leaguesRaw = loadFixture('riot-lol/rest_getLeagues.json');

/**
 * Collision count over an arbitrary set of rows, keyed by a chosen field. Deliberately reimplemented
 * here rather than imported from src/sources/riot/rest/teams.ts — production code only ever needs
 * the narrowed, name-keyed index (`buildTeamIndex`); this measures the *unnarrowed* candidate sets
 * that justified choosing name over code in the first place, which nothing in src/ computes.
 */
function countCollisions(rows: readonly RiotTeamRecord[], key: (r: RiotTeamRecord) => string): number {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const k = key(r);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.values()].filter((n) => n > 1).length;
}

describe('team index collisions (full 1568-row capture)', () => {
  const { items: allTeams } = parseTeams(fullTeamsRaw);
  const activeTeams = allTeams.filter((t) => t.status === 'active');

  it('has the row counts the full capture is known to have', () => {
    expect(allTeams.length).toBe(1568);
    expect(activeTeams.length).toBe(1176);
    expect(allTeams.length - activeTeams.length).toBe(392);
  });

  it('collides far more by code than by name over all active rows', () => {
    // config/leagues.json and docs/sources/lolesports-rest.md: 46 by code, 15 by name.
    expect(countCollisions(activeTeams, (r) => r.code)).toBe(46);
    expect(countCollisions(activeTeams, (r) => normalizeTeamName(r.name))).toBe(15);
  });

  it('has zero name collisions once narrowed to the covered regional leagues, and exactly one by code', () => {
    const { items: leagues } = parseLeagues(leaguesRaw, 'lol');
    const nameBySlug = new Map(leagues.map((l) => [l.slug, l.name]));
    const homeLeagueNames = new Set(
      realLeagueConfig()
        .teamHomeLeagueSlugs()
        .map((slug) => nameBySlug.get(slug))
        .filter((name): name is string => name !== undefined),
    );

    const index = buildTeamIndex(allTeams, homeLeagueNames);

    // config/leagues.json's measurements.teamTable: 168 rows, 168 distinct names (0 collisions),
    // 167 distinct codes (1 collision: EG).
    expect(index.size).toBe(168);
    expect(index.byName.size).toBe(168);
    expect([...index.byName.values()].filter((rows) => rows.length > 1)).toHaveLength(0);
    expect(index.byCode.size).toBe(167);
    const codeCollisions = [...index.byCode.entries()].filter(([, rows]) => rows.length > 1);
    expect(codeCollisions.map(([code]) => code)).toEqual(['EG']);
  });
});
