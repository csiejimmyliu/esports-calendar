/**
 * The acceptance criterion, as a test: SPEC §8 Stage 0 — "a CLI prints the next 7 days of LCK
 * matches in correct Taipei time."
 */

import { describe, expect, it } from 'vitest';
import { formatMatchLine, parseArgs, selectUpcoming } from '../src/cli/format.js';
import { createRiotRestLolAdapter, fixtureTransport, GLOBAL_SCOPE } from '../src/sources/riot/rest/adapter.js';
import type { SourceMatch } from '../src/core/types.js';
import { FIXTURE_CAPTURED_AT, loadFixture, realLeagueConfig } from './fixtures.js';

const now = new Date(FIXTURE_CAPTURED_AT);
const adapter = createRiotRestLolAdapter(
  fixtureTransport({
    schedule: loadFixture('riot-lol/rest_getSchedule.json'),
    leagues: loadFixture('riot-lol/rest_getLeagues.json'),
    teams: loadFixture('riot-lol/rest_getTeams.json'),
  }),
  realLeagueConfig(),
);
const all = (await adapter.fetchMatches(GLOBAL_SCOPE)).items;

describe('selectUpcoming', () => {
  it('returns the next 7 days of LCK', () => {
    const rows = selectUpcoming(all, { leagueSlug: 'lck', days: 7, now });
    expect(rows.map((m) => m.startsAtUtc)).toEqual(['2026-08-09T08:00:00Z', '2026-08-09T10:00:00Z']);
  });

  it('excludes lck_challengers_league, which a prefix or substring match would let through', () => {
    // Not hypothetical: the challengers league has matches on 08-10 and 08-11, inside the same
    // window, on days the main league does not play. A sloppy filter adds the wrong rows.
    const rows = selectUpcoming(all, { leagueSlug: 'lck', days: 7, now });
    expect(rows.every((m) => m.leagueSlug === 'lck')).toBe(true);

    const challengers = selectUpcoming(all, { leagueSlug: 'lck_challengers_league', days: 7, now });
    expect(challengers).toHaveLength(4);
    expect(rows.map((m) => m.externalId)).not.toEqual(expect.arrayContaining(challengers.map((m) => m.externalId)));
  });

  it('excludes matches that already started', () => {
    const rows = selectUpcoming(all, { leagueSlug: 'lck', days: 7, now });
    expect(rows.every((m) => m.startsAtUtc >= FIXTURE_CAPTURED_AT)).toBe(true);
  });

  it('is sorted chronologically', () => {
    const rows = selectUpcoming(all, { leagueSlug: 'lcp', days: 7, now });
    const times = rows.map((m) => m.startsAtUtc);
    expect(times).toEqual([...times].sort());
  });
});

describe('rendering', () => {
  const rows = selectUpcoming(all, { leagueSlug: 'lck', days: 7, now });

  it('renders 08:00Z as 16:00 Taipei', () => {
    expect(formatMatchLine(rows[0] as SourceMatch, 'Asia/Taipei', false)).toContain('16:00');
    // Stage 0.5: the printed side is CODE#id, because the id existing at all is the deliverable
    // and a name-only line cannot show the difference between resolved and unresolved.
    expect(formatMatchLine(rows[0] as SourceMatch, 'Asia/Taipei', false)).toContain(
      'DK#100725845018863243 vs KT#99566404579461230',
    );
  });

  it('renders the same match differently in another zone', () => {
    expect(formatMatchLine(rows[0] as SourceMatch, 'Europe/Berlin', false)).toContain('10:00');
  });

  it('shows TBD for an undecided opponent rather than a team named TBD', () => {
    const tbd = all.find((m) => m.sides.every((s) => s.team === null));
    expect(tbd).toBeDefined();
    expect(formatMatchLine(tbd as SourceMatch, 'Asia/Taipei', false)).toContain('TBD vs TBD');
  });

  it('never prints a score by default, including for completed matches (FR-3)', () => {
    const completed = all.find(
      (m) => m.state === 'completed' && (m.sides[0].score ?? 0) > (m.sides[1].score ?? 0),
    );
    expect(completed).toBeDefined();
    const match = completed as SourceMatch;
    const score = `${String(match.sides[0].score)}-${String(match.sides[1].score)}`;

    expect(formatMatchLine(match, 'Asia/Taipei', false)).not.toContain(score);
  });

  it('prints a score only when spoilers are asked for', () => {
    const completed = all.find(
      (m) => m.state === 'completed' && (m.sides[0].score ?? 0) > (m.sides[1].score ?? 0),
    ) as SourceMatch;
    const score = `${String(completed.sides[0].score)}-${String(completed.sides[1].score)}`;

    expect(formatMatchLine(completed, 'Asia/Taipei', true)).toContain(score);
  });
});

describe('parseArgs', () => {
  it('defaults to the acceptance criterion', () => {
    expect(parseArgs([])).toEqual({
      league: 'lck',
      days: 7,
      tz: 'Asia/Taipei',
      now: null,
      live: false,
      spoilers: false,
      fixture: 'rest_getSchedule.json',
    });
  });

  it('rejects an unknown flag rather than ignoring it', () => {
    expect(() => parseArgs(['--leage', 'lck'])).toThrow(/unknown argument/);
  });

  it('rejects a non-numeric --days', () => {
    expect(() => parseArgs(['--days', 'seven'])).toThrow(/must be a number/);
  });
});
