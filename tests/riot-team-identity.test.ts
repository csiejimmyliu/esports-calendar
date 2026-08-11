/**
 * Stage 0.5 — team identity.
 *
 * The claim under test is not "codes can be looked up". It is that the lookup is *narrowed
 * correctly*, because an unnarrowed lookup does not fail loudly — it attaches a real, wrong team
 * id to a real match, and every subscription downstream then follows the wrong team.
 *
 * Nothing here reads the wall clock. `rest_getTeams.json` and both schedule captures are frozen.
 */

import { describe, expect, it } from 'vitest';

import { createLeagueConfig } from '../src/config/leagues.js';
import type { SourceMatch } from '../src/core/types.js';
import type { WarningCode } from '../src/core/warnings.js';
import { parseLeagues, parseSchedule } from '../src/sources/riot/rest/parse.js';
import { buildTeamIndex, parseTeams, resolveTeam } from '../src/sources/riot/rest/teams.js';
import type { RiotTeamRecord, TeamIndex } from '../src/sources/riot/rest/teams.js';
import { loadFixture, matchEvent, realLeagueConfig, scheduleEnvelope, testLeagueConfig } from './fixtures.js';

const teamsRaw = loadFixture('riot-lol/rest_getTeams.json');
const leaguesRaw = loadFixture('riot-lol/rest_getLeagues.json');
const scheduleRaw = loadFixture('riot-lol/rest_getSchedule.json');
const ewcRaw = loadFixture('riot-lol/rest_getSchedule_ewc.json');

const leagueConfig = realLeagueConfig();
const parsedLeagues = parseLeagues(leaguesRaw, 'lol').items;
const leagueIdBySlug = new Map(parsedLeagues.map((l) => [l.slug, l.externalId]));
const nameBySlug = new Map(parsedLeagues.map((l) => [l.slug, l.name]));

/** The same slug -> localized name translation the adapter performs. */
function majorNames(config = leagueConfig): Set<string> {
  const names = new Set<string>();
  for (const slug of config.majorSlugs()) {
    const name = nameBySlug.get(slug);
    if (name !== undefined) names.add(name);
  }
  return names;
}

const teamRecords = parseTeams(teamsRaw).items;
const index = buildTeamIndex(teamRecords, majorNames());

function parse(raw: unknown, opts: { teamIndex?: TeamIndex } = {}): ReturnType<typeof parseSchedule> {
  return parseSchedule(raw, {
    game: 'lol',
    leagueIdBySlug,
    leagueConfig,
    teamIndex: opts.teamIndex ?? index,
  });
}

function countOf(warnings: { code: WarningCode; count: number }[], code: WarningCode): number {
  return warnings.find((w) => w.code === code)?.count ?? 0;
}

function sideByCode(matches: readonly SourceMatch[], slug: string | null, code: string) {
  for (const m of matches) {
    if (m.leagueSlug !== slug) continue;
    for (const s of m.sides) if (s.team?.code === code) return s.team;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The index
// ---------------------------------------------------------------------------

describe('the team table', () => {
  it('excludes archived teams', () => {
    // status is a listing flag, not a currency signal — the master table keeps historical orgs.
    const archived = teamRecords.filter((t) => t.status === 'archived');
    expect(archived.length).toBeGreaterThan(0);

    const indexed = new Set([...index.byCode.values()].flat().map((t) => t.externalId));
    for (const t of archived) expect(indexed.has(t.externalId)).toBe(false);
  });

  it('excludes teams with no home league', () => {
    // 486 of the 1176 active teams upstream are in this state: academy squads and regional teams
    // with no league to classify them by. They cannot be narrowed, so they cannot be trusted.
    const homeless = teamRecords.filter((t) => t.status === 'active' && t.homeLeagueName === null);
    expect(homeless.length).toBeGreaterThan(0);

    const indexed = new Set([...index.byCode.values()].flat().map((t) => t.externalId));
    for (const t of homeless) expect(indexed.has(t.externalId)).toBe(false);
  });

  it('excludes teams whose home league is not major, including second teams', () => {
    const second = teamRecords.filter((t) => t.homeLeagueName === 'LCK Challengers');
    expect(second.length).toBeGreaterThan(0);

    const indexed = new Set([...index.byCode.values()].flat().map((t) => t.externalId));
    for (const t of second) expect(indexed.has(t.externalId)).toBe(false);
  });

  it('contains exactly one colliding code, and it is EG', () => {
    // Measured on the full 1568-row response: 27 codes collide unnarrowed, 1 collides narrowed.
    // The trimmed fixture cannot reproduce 27, but it does carry both halves of the survivor.
    const colliding = [...index.byCode.entries()].filter(([, v]) => v.length > 1).map(([c]) => c);
    expect(colliding).toEqual(['EG']);
  });
});

// ---------------------------------------------------------------------------
// Resolution rules, as pure functions
// ---------------------------------------------------------------------------

describe('resolveTeam', () => {
  const alpha: RiotTeamRecord = {
    externalId: '1', name: 'Alpha', code: 'ALP', logoUrl: null, status: 'active', homeLeagueName: 'LCK',
  };
  const alphaEu: RiotTeamRecord = {
    externalId: '2', name: 'Alpha EU', code: 'ALP', logoUrl: null, status: 'active', homeLeagueName: 'LEC',
  };
  const twoWay = buildTeamIndex([alpha, alphaEu], new Set(['LCK', 'LEC']));
  const oneWay = buildTeamIndex([alpha], new Set(['LCK']));

  it('does not look at all when the league is not major', () => {
    // The gate the team table alone cannot provide.
    for (const tier of ['minor', 'unclassified'] as const) {
      expect(resolveTeam(oneWay, { code: 'ALP', leagueSlug: 'x', tier, override: undefined })).toEqual({
        kind: 'out-of-scope',
      });
    }
  });

  it('warns rather than guessing when a code is claimed twice and no override applies', () => {
    const r = resolveTeam(twoWay, { code: 'ALP', leagueSlug: 'worlds', tier: 'major', override: undefined });
    expect(r.kind).toBe('ambiguous');
  });

  it('ignores an override that names a team absent from the table', () => {
    // A stale override is a config bug. Honouring it would attach an id nothing else knows.
    const r = resolveTeam(twoWay, {
      code: 'ALP',
      leagueSlug: 'worlds',
      tier: 'major',
      override: { code: 'ALP', leagueSlug: 'worlds', teamId: '404', reason: 'stale' },
    });
    expect(r.kind).toBe('ambiguous');
  });

  it('reports an unknown code as unresolved rather than throwing', () => {
    const r = resolveTeam(oneWay, { code: 'NOPE', leagueSlug: 'lck', tier: 'major', override: undefined });
    expect(r).toEqual({ kind: 'unresolved', code: 'NOPE' });
  });
});

// ---------------------------------------------------------------------------
// Against the real captures
// ---------------------------------------------------------------------------

describe('the main schedule capture', () => {
  const result = parse(scheduleRaw);

  it('resolves every non-TBD team in a major league', () => {
    const majorSlugs = new Set(leagueConfig.majorSlugs());
    const sides = result.items
      .filter((m) => m.leagueSlug !== null && majorSlugs.has(m.leagueSlug))
      .flatMap((m) => m.sides)
      .filter((s) => s.team !== null);

    expect(sides).toHaveLength(86);
    expect(sides.every((s) => s.team?.externalId !== null)).toBe(true);
    expect(countOf(result.warnings, 'team-unresolved')).toBe(0);
    expect(countOf(result.warnings, 'team-ambiguous')).toBe(0);
  });

  it('does not resolve teams in a minor league whose codes collide with major teams', () => {
    /**
     * The test this whole design exists for.
     *
     * lck_challengers_league fields second teams carrying their parent's code. Against a
     * major-only table, eleven of those sides would otherwise be handed the *main* LCK org's id —
     * "kt Challengers" becoming kt Rolster — which is a wrong answer that looks exactly like a
     * right one. Eleven is measured against this capture, not assumed.
     */
    const challenger = result.items.filter((m) => m.leagueSlug === 'lck_challengers_league');
    const collidingSides = challenger
      .flatMap((m) => m.sides)
      .filter((s) => s.team?.code != null && index.byCode.has(s.team.code));

    expect(collidingSides).toHaveLength(11);
    expect(collidingSides.every((s) => s.team?.externalId === null)).toBe(true);
    // Names survive: an unidentified team is still a calendar entry.
    expect(sideByCode(challenger, 'lck_challengers_league', 'KT')?.name).toBe('kt Challengers');
  });

  it('leaves a deliberately excluded league unresolved and does not warn about it', () => {
    // KeSPA Cup is explicitly minor in config/leagues.json: a product decision, already recorded
    // there, so it is not news at fetch time. Absence from the file would be.
    expect(leagueConfig.tierFor('kespa_cup')).toBe('minor');
    const kespa = result.items.filter((m) => m.leagueSlug === 'kespa_cup');
    expect(kespa.length).toBeGreaterThan(0);
    expect(kespa.flatMap((m) => m.sides).every((s) => s.team === null || s.team.externalId === null)).toBe(true);
    expect(countOf(result.warnings, 'unclassified-league')).toBe(0);
  });

  it('prefers the master table logo and still forces https', () => {
    // 271 of the 290 table rows are http, so the getTeams asset is newer but not safer.
    const gen = sideByCode(result.items, 'lck', 'GEN');
    expect(gen?.externalId).toBe('100205573495116443');
    expect(gen?.logoUrl?.startsWith('https://')).toBe(true);

    const fromTable = teamRecords.find((t) => t.externalId === '100205573495116443');
    expect(gen?.logoUrl).toBe(fromTable?.logoUrl);
  });
});

describe('the Esports World Cup capture', () => {
  const result = parse(ewcRaw);

  it('resolves an LCK team competing under an international league slug', () => {
    /**
     * Cross-league resolution: a team's identity comes from the master table, not from the league
     * the match happens to be played under. In the full 28-event response 48 of 56 non-TBD sides
     * are in this position; six events are committed here.
     */
    const t1 = sideByCode(result.items, 'ewc_lol', 'T1');
    expect(t1?.externalId).toBe('98767991853197861');

    const homeLeague = teamRecords.find((t) => t.externalId === t1?.externalId)?.homeLeagueName;
    expect(homeLeague).toBe('LCK');
    expect(nameBySlug.get('ewc_lol')).toBe('Esports World Cup');
  });

  it('resolves every side of the international capture, including teams homed at the event', () => {
    const sides = result.items.flatMap((m) => m.sides).filter((s) => s.team !== null);
    expect(sides).toHaveLength(12);
    expect(sides.every((s) => s.team?.externalId !== null)).toBe(true);

    // TS is homed at the Esports World Cup itself — not every team at an international event is
    // playing away from its home league, and the same code path must handle both.
    const ts = sideByCode(result.items, 'ewc_lol', 'TS');
    expect(teamRecords.find((t) => t.externalId === ts?.externalId)?.homeLeagueName).toBe('Esports World Cup');
  });
});

// ---------------------------------------------------------------------------
// The paths that must not crash
// ---------------------------------------------------------------------------

describe('failure paths', () => {
  it('warns and keeps the team name when no row claims the code', () => {
    const event = matchEvent({
      league: { name: 'LCK', slug: 'lck' },
      match: {
        id: '900000000000000009',
        flags: [],
        strategy: { type: 'bestOf', count: 3 },
        teams: [
          { name: 'Newly Promoted', code: 'ZZZZ', image: null, result: { outcome: null, gameWins: 0 } },
          { name: 'T1', code: 'T1', image: null, result: { outcome: null, gameWins: 0 } },
        ],
      },
    });
    const out = parse(scheduleEnvelope([event]));

    expect(out.items).toHaveLength(1);
    const [unknown, known] = out.items[0]!.sides;
    expect(unknown.team?.name).toBe('Newly Promoted');
    expect(unknown.team?.externalId).toBeNull();
    expect(known.team?.externalId).toBe('98767991853197861');
    expect(countOf(out.warnings, 'team-unresolved')).toBe(1);
  });

  it('EG resolves to the LCS id under lcs and the LEC id under lec', () => {
    // The one collision no rule can settle: both are first teams in major leagues.
    const eg = (slug: string, name: string) =>
      parse(
        scheduleEnvelope([
          matchEvent({
            league: { name, slug },
            match: {
              id: '900000000000000010',
              flags: [],
              strategy: { type: 'bestOf', count: 3 },
              teams: [
                { name: 'Evil Geniuses', code: 'EG', image: null, result: { outcome: null, gameWins: 0 } },
                { name: 'T1', code: 'T1', image: null, result: { outcome: null, gameWins: 0 } },
              ],
            },
          }),
        ]),
      );

    const lcs = eg('lcs', 'LCS');
    expect(lcs.items[0]!.sides[0].team?.externalId).toBe('103461966951059521');
    expect(countOf(lcs.warnings, 'team-ambiguous')).toBe(0);

    const lec = eg('lec', 'LEC');
    expect(lec.items[0]!.sides[0].team?.externalId).toBe('109218871531830908');
    expect(countOf(lec.warnings, 'team-ambiguous')).toBe(0);
  });

  it('warns and resolves nothing for a colliding code with no override', () => {
    // EG at an international event: no override covers it, and nothing in the response can decide
    // which org it is. Refusing is the correct answer, not a gap.
    const out = parse(
      scheduleEnvelope([
        matchEvent({
          league: { name: 'Worlds', slug: 'worlds' },
          match: {
            id: '900000000000000011',
            flags: [],
            strategy: { type: 'bestOf', count: 5 },
            teams: [
              { name: 'Evil Geniuses', code: 'EG', image: null, result: { outcome: null, gameWins: 0 } },
              { name: 'T1', code: 'T1', image: null, result: { outcome: null, gameWins: 0 } },
            ],
          },
        }),
      ]),
    );

    expect(out.items[0]!.sides[0].team?.name).toBe('Evil Geniuses');
    expect(out.items[0]!.sides[0].team?.externalId).toBeNull();
    expect(countOf(out.warnings, 'team-ambiguous')).toBe(1);
  });

  it('warns once per event for a league absent from the config, and resolves nothing', () => {
    // Absence is not the same as an explicit minor: it means a league appeared upstream after the
    // file was reviewed. Three did during 2026 alone.
    const config = testLeagueConfig([{ slug: 'lck', tier: 'major' }]);
    const out = parseSchedule(
      scheduleEnvelope([matchEvent({ league: { name: 'Brand New League', slug: 'bnl' } })]),
      { game: 'lol', leagueConfig: config, teamIndex: index },
    );

    expect(config.tierFor('bnl')).toBe('unclassified');
    expect(out.items).toHaveLength(1);
    expect(out.items[0]!.sides.every((s) => s.team?.externalId === null)).toBe(true);
    expect(countOf(out.warnings, 'unclassified-league')).toBe(1);
  });

  it('never lets player data through', () => {
    // SPEC excludes it, and the fixture is stored without it. Both halves are asserted so that
    // re-capturing the fixture with players intact cannot silently start leaking them.
    expect(JSON.stringify(teamsRaw)).not.toContain('"players"');
    expect(JSON.stringify(teamRecords)).not.toContain('player');
    expect(Object.keys(teamRecords[0]!).sort()).toEqual([
      'code', 'externalId', 'homeLeagueName', 'logoUrl', 'name', 'status',
    ]);
  });

  it('keeps an unknown team status out of the table instead of throwing', () => {
    const out = parseTeams({
      data: {
        teams: [
          { id: '1', name: 'Alpha', code: 'ALP', status: 'hibernating', homeLeague: { name: 'LCK', region: 'KOREA' } },
        ],
      },
    });
    expect(out.warnings.map((w) => w.code)).toContain('unknown-team-status');
    expect(buildTeamIndex(out.items, new Set(['LCK'])).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The config file itself
// ---------------------------------------------------------------------------

describe('config/leagues.json', () => {
  it('classifies every league the live getLeagues response returns', () => {
    // An unclassified league is a warning at runtime; having one on the day the file was written
    // would mean it was never finished.
    const unclassified = parsedLeagues.filter((l) => leagueConfig.tierFor(l.slug) === 'unclassified');
    expect(unclassified.map((l) => l.slug)).toEqual([]);
    expect(parsedLeagues).toHaveLength(45);
    expect(leagueConfig.majorSlugs()).toHaveLength(14);
  });

  it('refuses a file that classifies one slug twice', () => {
    expect(() =>
      createLeagueConfig({
        leagues: [{ slug: 'lck', tier: 'major' }, { slug: 'lck', tier: 'minor' }],
      }),
    ).toThrow(/more than once/);
  });

  it('refuses to let a file write unclassified, which is the absence of an entry', () => {
    expect(() => createLeagueConfig({ leagues: [{ slug: 'lck', tier: 'unclassified' }] })).toThrow();
  });
});
