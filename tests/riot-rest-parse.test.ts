/**
 * Golden-fixture parser tests.
 *
 * `fixtures/riot-lol/rest_getSchedule.json` is a real captured response. If Riot changes the
 * shape, these turn red in CI — which is the point: a scraper that breaks returns HTTP 200 and
 * zero rows, and no liveness check will ever notice.
 *
 * Nothing here reads the wall clock. The fixture's matches are fixed in time.
 */

import { describe, expect, it } from 'vitest';
import { parseLeagues, parseSchedule, parseSchedulePages } from '../src/sources/riot/rest/parse.js';
import type { SourceMatch } from '../src/core/types.js';
import type { WarningCode } from '../src/core/warnings.js';
import { buildTeamIndex, parseTeams } from '../src/sources/riot/rest/teams.js';
import { loadFixture, matchEvent, realLeagueConfig, scheduleEnvelope } from './fixtures.js';

const schedule = loadFixture('riot-lol/rest_getSchedule.json');
const leagues = loadFixture('riot-lol/rest_getLeagues.json');

const leagueIdBySlug = new Map(
  parseLeagues(leagues, 'lol').items.map((l) => [l.slug, l.externalId]),
);

const leagueConfig = realLeagueConfig();
// teamHomeLeagueSlugs, not majorSlugs — the same narrowing the adapter performs. See
// src/config/leagues.ts: an international event must never define who the teams are.
const teamIndex = buildTeamIndex(
  parseTeams(loadFixture('riot-lol/rest_getTeams.json')).items,
  new Set(
    leagueConfig
      .teamHomeLeagueSlugs()
      .map((slug) => parseLeagues(leagues, 'lol').items.find((l) => l.slug === slug)?.name)
      .filter((name): name is string => name !== undefined),
  ),
);

function parse(raw: unknown): ReturnType<typeof parseSchedule> {
  return parseSchedule(raw, { game: 'lol', leagueIdBySlug, leagueConfig, teamIndex });
}

function codes(warnings: { code: WarningCode }[]): WarningCode[] {
  return warnings.map((w) => w.code).sort();
}

function countOf(warnings: { code: WarningCode; count: number }[], code: WarningCode): number {
  return warnings.find((w) => w.code === code)?.count ?? 0;
}

describe('parseSchedule against the golden fixture', () => {
  const result = parse(schedule);

  it('parses every event in the captured response', () => {
    expect(result.items).toHaveLength(80);
  });

  it('attaches league ids from getLeagues, which getSchedule itself does not carry', () => {
    const lck = result.items.find((m) => m.leagueSlug === 'lck');
    expect(lck?.leagueExternalId).toBe('98767991310872058');
  });

  it('produces the LCK rows for 2026-08-09 exactly', () => {
    const rows = result.items
      .filter((m) => m.leagueSlug === 'lck' && m.startsAtUtc.startsWith('2026-08-09'))
      .map((m) => ({
        startsAtUtc: m.startsAtUtc,
        state: m.state,
        seriesLength: m.seriesLength,
        gamesPlayed: m.gamesPlayed,
        teams: m.sides.map((s) => s.team?.code ?? 'TBD'),
      }));

    expect(rows).toEqual([
      {
        startsAtUtc: '2026-08-09T08:00:00Z',
        state: 'unstarted',
        seriesLength: 3,
        gamesPlayed: 0,
        teams: ['DK', 'KT'],
      },
      {
        startsAtUtc: '2026-08-09T10:00:00Z',
        state: 'unstarted',
        seriesLength: 3,
        gamesPlayed: 0,
        teams: ['BFX', 'KRX'],
      },
    ]);
  });

  it('rewrites http logo URLs to https without one warning per team', () => {
    const logos = result.items.flatMap((m) => m.sides.map((s) => s.team?.logoUrl)).filter(Boolean);
    expect(logos.length).toBeGreaterThan(100);
    expect(logos.every((url) => url?.startsWith('https://'))).toBe(true);
  });

  it('reports no team identity only when the master table is missing', () => {
    // Until Stage 0.5 this was unconditional: getSchedule alone has 80 events, 80 ids, and none of
    // them a team's. With the getTeams join supplied the warning must be silent, or it becomes a
    // line every sync run prints and nobody reads.
    expect(countOf(result.warnings, 'no-team-identity')).toBe(0);

    const withoutTeams = parseSchedule(schedule, { game: 'lol', leagueIdBySlug, leagueConfig });
    expect(countOf(withoutTeams.warnings, 'no-team-identity')).toBe(1);
    expect(
      withoutTeams.items.every((m) => m.sides.every((s) => s.team === null || s.team.externalId === null)),
    ).toBe(true);
    // and the matches are all still there
    expect(withoutTeams.items).toHaveLength(80);
  });

  it('never invents a stream URL', () => {
    expect(result.items.every((m) => m.streamUrl === null)).toBe(true);
  });

  it('leaves tournament unset, because getSchedule carries no tournament object', () => {
    expect(result.items.every((m) => m.tournamentExternalId === null)).toBe(true);
  });
});

describe('edge cases the fixture actually contains', () => {
  const result = parse(schedule);

  it('TBD opponents become null sides, not teams named "TBD"', () => {
    const tbd = result.items.find((m) => m.externalId === '117047583684384478');
    expect(tbd?.sides).toEqual([
      { team: null, score: null },
      { team: null, score: null },
    ]);
  });

  it('the null-result signal is exact across the whole fixture', () => {
    // This is the premise the state correction rests on, so it is asserted rather than assumed:
    // every unplayed match has no result, and no played match lacks one. 7 and 73 of 80.
    const unplayed = result.items.filter((m) => m.sides.every((s) => s.score === null));
    const played = result.items.filter((m) => m.sides.every((s) => s.score !== null));
    expect(unplayed).toHaveLength(7);
    expect(played).toHaveLength(73);
    // No match is half-and-half — a partial signal would make the rule ambiguous.
    expect(unplayed.length + played.length).toBe(result.items.length);
    expect(unplayed.every((m) => m.state === 'unstarted')).toBe(true);
  });

  it('corrects TBD + completed to unstarted rather than repeating what REST said', () => {
    // Three such rows. REST's state field splits TBD matches arbitrarily — two kespa_cup matches
    // one day apart disagree — so it is overridden, not merely flagged.
    const corrected = result.warnings.find((x) => x.code === 'lossy-state');
    expect(corrected?.count).toBe(3);
    expect(corrected?.message).toMatch(/corrected/);

    const cacg = result.items.find((m) => m.externalId === '117047583684384478');
    expect(cacg?.state).toBe('unstarted');
  });

  it('corrects a match scheduled in the future that REST reports as completed', () => {
    // kespa_cup 116929376557102192 starts the day *after* this fixture was captured and REST
    // calls it completed. So "state is only wrong for matches in the past" is not a safe rule.
    const kespa = result.items.find((m) => m.externalId === '116929376557102192');
    expect(kespa?.startsAtUtc).toBe('2026-08-10T10:30:00Z');
    expect(kespa?.state).toBe('unstarted');
    expect(kespa?.sides.every((s) => s.team === null)).toBe(true);
  });

  it('leaves TBD + unstarted alone and does not count it as a correction', () => {
    // Four such rows. Correcting something that was already right would inflate the warning
    // count into meaninglessness.
    const untouched = result.items.filter(
      (m) => m.sides.every((s) => s.team === null) && m.state === 'unstarted',
    );
    expect(untouched).toHaveLength(7); // 4 originally + 3 corrected
    expect(result.warnings.find((x) => x.code === 'lossy-state')?.count).toBe(3);
  });

  it('leaves a completed match between real teams untouched', () => {
    // The correction must not swallow genuine results: {gameWins: 0, outcome: null} is a present
    // result, not a missing one.
    const real = result.items.find((m) => m.externalId === '115548147900553469');
    expect(real?.state).toBe('completed');
    expect(real?.sides.every((s) => s.team !== null)).toBe(true);
  });

  it('derives gamesPlayed from per-team win counts, since getSchedule has no games array', () => {
    const completed = result.items.find((m) => m.externalId === '115548147900553469');
    expect(completed?.state).toBe('completed');
    expect(completed?.seriesLength).toBe(3);
    // A Bo3 that ended 2-0: seriesLength 3, gamesPlayed 2. Not the same number.
    expect(completed?.gamesPlayed).toBe(2);
    expect(completed?.sides.map((s) => s.score)).toEqual([2, 0]);
  });

  it('keeps a not-yet-played known team distinct from TBD', () => {
    // {gameWins: 0, outcome: null} is a real team with no games played. `result: null` is TBD.
    const upcoming = result.items.find((m) => m.startsAtUtc === '2026-08-09T08:00:00Z' && m.leagueSlug === 'lck');
    expect(upcoming?.sides.every((s) => s.team !== null)).toBe(true);
    expect(upcoming?.sides.map((s) => s.score)).toEqual([0, 0]);
  });
});

describe('edge cases the fixture does not contain — a fixture proves existence, never absence', () => {
  it('skips type "show" silently, because it is a known non-match event', () => {
    // 2 of 80 VALORANT events were `show`, on the same backend. LoL emits them too; we simply
    // did not sample one. A parser doing event.match.id would crash here.
    const raw = scheduleEnvelope([
      { startTime: '2026-08-09T08:00:00Z', state: 'inProgress', type: 'show', league: { name: 'LCK', slug: 'lck' } },
      matchEvent(),
    ]);
    const result = parse(raw);
    expect(result.items).toHaveLength(1);
    expect(codes(result.warnings)).not.toContain('unknown-event-type');
  });

  it('warns on an unknown event type rather than throwing or dropping it in silence', () => {
    const raw = scheduleEnvelope([matchEvent({ type: 'exhibition' })]);
    const result = parse(raw);
    expect(result.items).toHaveLength(0);
    expect(countOf(result.warnings, 'unknown-event-type')).toBe(1);
  });

  it('warns on an unknown state and falls back to unstarted, the spoiler-safe direction', () => {
    const raw = scheduleEnvelope([matchEvent({ state: 'postponed' })]);
    const result = parse(raw);
    expect(result.items[0]?.state).toBe('unstarted');
    expect(countOf(result.warnings, 'unknown-match-state')).toBe(1);
  });

  it('skips a match whose participant count is not two, and says so', () => {
    const raw = scheduleEnvelope([
      matchEvent({
        match: {
          id: '1',
          flags: [],
          strategy: { type: 'bestOf', count: 3 },
          teams: [{ name: 'Solo', code: 'SOL', image: null, result: null }],
        },
      }),
      matchEvent(),
    ]);
    const result = parse(raw);
    expect(result.items).toHaveLength(1);
    expect(countOf(result.warnings, 'non-binary-sides')).toBe(1);
  });

  it('isolates one malformed event instead of rejecting the whole response', () => {
    const raw = scheduleEnvelope([{ nonsense: true }, matchEvent()]);
    const result = parse(raw);
    expect(result.items).toHaveLength(1);
    expect(countOf(result.warnings, 'unparsable-item')).toBe(1);
  });

  it('reports a zero-row response as suspect rather than as an ordinary empty day', () => {
    // The failure mode the whole project guards against: 200, valid JSON, nothing in it.
    const result = parse(scheduleEnvelope([]));
    expect(result.items).toHaveLength(0);
    expect(codes(result.warnings)).toContain('suspect-empty');
  });

  it('does not cry suspect-empty when rows were actually returned', () => {
    const result = parse(scheduleEnvelope([matchEvent()]));
    expect(codes(result.warnings)).not.toContain('suspect-empty');
  });

  it('refuses a start time with no timezone marker instead of guessing the zone', () => {
    expect(() => parse(scheduleEnvelope([matchEvent({ startTime: '2026-08-09T08:00:00' })]))).toThrow(
      /no timezone marker/,
    );
  });
});

describe('parseSchedulePages: observed ids vs. parsed items (Stage 1b)', () => {
  // detectCancellations (src/sync/cancellation.ts, via src/sync/ingest.ts) must be driven by what
  // a fetch actually saw, not by what survived parsing — those are not the same set. See
  // FetchResult.observed in src/core/source.ts.
  function pages(raw: unknown): ReturnType<typeof parseSchedulePages> {
    return parseSchedulePages([raw], { game: 'lol', leagueIdBySlug, leagueConfig, teamIndex });
  }

  it('keeps a non-binary-sides drop\'s id in observedExternalIds, so it is not read as absent', () => {
    const raw = scheduleEnvelope([
      matchEvent({
        match: {
          id: 'solo-side-1',
          flags: [],
          strategy: { type: 'bestOf', count: 3 },
          teams: [{ name: 'Solo', code: 'SOL', image: null, result: null }],
        },
      }),
    ]);
    const result = pages(raw);
    expect(result.items).toHaveLength(0);
    expect(result.observedExternalIds.has('solo-side-1')).toBe(true);
    expect(result.unidentifiedDrops).toBe(0);
  });

  it('counts a schema-validation failure as unidentified, with no id to preserve', () => {
    const result = pages(scheduleEnvelope([{ nonsense: true }, matchEvent()]));
    expect(result.items).toHaveLength(1);
    expect(result.unidentifiedDrops).toBe(1);
  });

  it('does not count a "show" event as a drop at all', () => {
    const raw = scheduleEnvelope([
      { startTime: '2026-08-09T08:00:00Z', state: 'inProgress', type: 'show', league: { name: 'LCK', slug: 'lck' } },
      matchEvent(),
    ]);
    const result = pages(raw);
    expect(result.unidentifiedDrops).toBe(0);
  });

  it('a normally-parsed match is in both items and observedExternalIds', () => {
    const result = pages(scheduleEnvelope([matchEvent()]));
    expect(result.items).toHaveLength(1);
    expect(result.observedExternalIds.has(result.items[0]?.externalId ?? '')).toBe(true);
  });
});

describe('parseLeagues', () => {
  const result = parseLeagues(leagues, 'lol');

  it('parses the captured league list', () => {
    expect(result.items).toHaveLength(45);
  });

  it('keeps lck and lck_challengers_league as separate leagues', () => {
    const slugs = result.items.map((l) => l.slug).filter((s) => s.includes('lck'));
    expect(slugs.sort()).toEqual(['lck', 'lck_challengers_league']);
  });

  it('exposes no tier, because no probed source has a usable one', () => {
    const lck: object | undefined = result.items.find((l) => l.slug === 'lck');
    expect(lck).toBeDefined();
    expect(lck && 'tier' in lck).toBe(false);
    expect(result.items.find((l) => l.slug === 'lck')?.region).toBe('KOREA');
  });
});

describe('the shape adapters must not leak', () => {
  it('produces no field naming Riot anywhere in a parsed match', () => {
    const [first] = parse(scheduleEnvelope([matchEvent()])).items;
    const keys = Object.keys(first as SourceMatch);
    expect(keys.some((k) => /riot|gql|persisted/i.test(k))).toBe(false);
  });
});
