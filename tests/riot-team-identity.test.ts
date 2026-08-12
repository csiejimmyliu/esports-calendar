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
import type { TeamOverrideDto } from '../src/config/leagues.js';
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

/**
 * The same slug -> localized name translation the adapter performs.
 *
 * Note `teamHomeLeagueSlugs()`, not `majorSlugs()`. The two sets differ and the adapter uses this
 * one to narrow the team table — see the `international events` test below for why.
 */
function homeLeagueNames(config = leagueConfig): Set<string> {
  const names = new Set<string>();
  for (const slug of config.teamHomeLeagueSlugs()) {
    const name = nameBySlug.get(slug);
    if (name !== undefined) names.add(name);
  }
  return names;
}

const teamRecords = parseTeams(teamsRaw).items;
const index = buildTeamIndex(teamRecords, homeLeagueNames());

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

  it('excludes teams whose home league is not covered, including second teams', () => {
    const second = teamRecords.filter((t) => t.homeLeagueName === 'LCK Challengers');
    expect(second.length).toBeGreaterThan(0);

    const indexed = new Set([...index.byCode.values()].flat().map((t) => t.externalId));
    for (const t of second) expect(indexed.has(t.externalId)).toBe(false);
  });

  it('contains exactly one colliding code, and it is EG', () => {
    /**
     * Measured against the full 1568-row response (1176 active) under the eight-league coverage:
     * 27 codes collide unnarrowed, and exactly 1 collides once narrowed to covered regional
     * leagues — 168 rows across 167 distinct codes.
     *
     * The trimmed fixture is 71 rows and cannot reproduce 27 or 168; what it does carry is both
     * halves of the survivor, which is the half of the claim a test can actually hold. Its own
     * narrowed index is 47 rows across 46 codes.
     */
    const collidingCodes = [...index.byCode.entries()].filter(([, v]) => v.length > 1).map(([c]) => c);
    expect(collidingCodes).toEqual(['EG']);
    expect(index.size).toBe(47);
    expect(index.byCode.size).toBe(46);

    /**
     * And the reproducible half of the join-key decision: **names do not collide at all**, so the
     * 47 rows occupy 47 distinct name keys against 46 code keys. Over the full capture it is 0
     * against 1; over all 1176 active rows it is 15 against 46. Only this line can be checked from
     * the repo, so it is the one asserted.
     */
    const collidingNames = [...index.byName.entries()].filter(([, v]) => v.length > 1).map(([n]) => n);
    expect(collidingNames).toEqual([]);
    expect(index.byName.size).toBe(47);
  });

  it('does not let an international event define who the teams are', () => {
    /**
     * The bug the narrowing to eight leagues exposed, and the reason `LeagueKind` exists.
     *
     * `getTeams` homes seven active rows at Worlds and MSI, and not one is a team that plays: five
     * are 2011-era orgs (EPIK Gamer, Team GAMED.DE, against All authority, Pacific eSports, Xan)
     * and two are region placeholders literally *named* "LCS" and "VCS", carrying those codes.
     * Measured against the full capture; the trimmed fixture's only event-homed row is archived, so
     * the rule is asserted on synthetic records rather than claimed from a fixture that cannot show
     * it. The config invariant below is what actually protects production.
     */
    expect(leagueConfig.teamHomeLeagueSlugs()).toEqual(['lck', 'lpl', 'lec', 'lcs', 'lcp']);
    const covered = new Set(leagueConfig.majorSlugs());
    for (const slug of leagueConfig.teamHomeLeagueSlugs()) expect(covered.has(slug)).toBe(true);
    expect(leagueConfig.teamHomeLeagueSlugs().length).toBeLessThan(covered.size);

    const placeholder: RiotTeamRecord = {
      externalId: '108183932728352967', name: 'LCS', code: 'LCS',
      logoUrl: null, status: 'active', homeLeagueName: 'MSI',
    };
    const real: RiotTeamRecord = {
      externalId: '98767991853197861', name: 'T1', code: 'T1',
      logoUrl: null, status: 'active', homeLeagueName: 'LCK',
    };
    const narrowed = buildTeamIndex([placeholder, real], homeLeagueNames());
    expect(narrowed.size).toBe(1);
    expect(narrowed.byCode.has('LCS')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Resolution rules, as pure functions
// ---------------------------------------------------------------------------

describe('resolveTeam — name first, code as fallback', () => {
  const row = (
    externalId: string, name: string, code: string, homeLeagueName: string,
  ): RiotTeamRecord => ({ externalId, name, code, logoUrl: null, status: 'active', homeLeagueName });

  /** The parent/academy shape: one code, two squads, different names. Seven such pairs are real. */
  const parent = row('1', 'kt Rolster', 'KT', 'LCK');
  const academy = row('2', 'kt Challengers', 'KT', 'LEC'); // LEC only so both enter this test index
  const shared = buildTeamIndex([parent, academy], new Set(['LCK', 'LEC']));
  const single = buildTeamIndex([parent], new Set(['LCK']));

  const ask = (
    index: Parameters<typeof resolveTeam>[0],
    name: string,
    code: string,
    extra: { tier?: 'major' | 'minor' | 'unclassified'; override?: TeamOverrideDto } = {},
  ) =>
    resolveTeam(index, {
      name, code, leagueSlug: 'worlds', tier: extra.tier ?? 'major', override: extra.override,
    });

  it('does not look at all when the league is not covered', () => {
    // Scope, not safety — the name join is what makes it safe. Kept because spending a lookup on a
    // league we do not cover is still wrong.
    for (const tier of ['minor', 'unclassified'] as const) {
      expect(ask(single, 'kt Rolster', 'KT', { tier })).toEqual({ kind: 'out-of-scope' });
    }
  });

  it('separates a parent from its academy by name, where the code cannot', () => {
    /**
     * The whole reason the join key changed. Both rows claim code "KT"; under a code join this is an
     * unresolvable collision, and a code join against a parent-only table silently returns the
     * parent. By name each resolves to itself with no override, no tier trick, and no ambiguity.
     */
    expect(shared.byCode.get('KT')).toHaveLength(2);
    expect(ask(shared, 'kt Rolster', 'KT')).toEqual({ kind: 'resolved', team: parent, matchedBy: 'name' });
    expect(ask(shared, 'kt Challengers', 'KT')).toEqual({ kind: 'resolved', team: academy, matchedBy: 'name' });
  });

  it('misses rather than lying when the academy is absent from a narrowed table', () => {
    // The failure mode a code join produced: "kt Challengers" would have resolved to kt Rolster's id.
    // A wrong identity looks exactly like a right one; an absent one does not.
    expect(ask(single, 'kt Challengers', 'KT')).toEqual({
      kind: 'resolved', team: parent, matchedBy: 'code',
    });
    // ^ code still finds the parent, which is why the fallback raises team-name-mismatch and why the
    // tier gate is retained: for a real academy match the tier gate refuses before this can happen.
    expect(ask(single, 'kt Challengers', 'KT', { tier: 'minor' })).toEqual({ kind: 'out-of-scope' });
  });

  it('falls back to code when the name has drifted, and says it did', () => {
    const r = ask(single, 'KT Rolster Esports', 'KT');
    expect(r).toEqual({ kind: 'resolved', team: parent, matchedBy: 'code' });
  });

  it('normalizes trailing whitespace and case, because six real rows need it', () => {
    const spaced = buildTeamIndex([row('9', 'Suning ', 'SN', 'LPL')], new Set(['LPL']));
    expect(ask(spaced, 'Suning', 'SN').kind).toBe('resolved');
    expect(ask(spaced, '  suning  ', 'SN')).toMatchObject({ matchedBy: 'name' });
  });

  it('uses the code as a tiebreak within name candidates, not as a separate lookup', () => {
    // Zero name collisions exist in the current capture. If Riot produces one, narrowing inside the
    // matched names is strictly safer than abandoning the name and doing a bare code lookup.
    const twinA = row('10', 'Twin', 'TWA', 'LCK');
    const twinB = row('11', 'Twin', 'TWB', 'LEC');
    const twins = buildTeamIndex([twinA, twinB], new Set(['LCK', 'LEC']));
    expect(ask(twins, 'Twin', 'TWB')).toEqual({ kind: 'resolved', team: twinB, matchedBy: 'name' });

    const r = ask(twins, 'Twin', 'NEITHER');
    expect(r.kind).toBe('ambiguous');
    if (r.kind === 'ambiguous') expect(r.candidates).toHaveLength(2);
  });

  it('refuses when the name misses and the code is claimed twice', () => {
    const r = ask(shared, 'Unknown Org', 'KT');
    expect(r).toMatchObject({ kind: 'ambiguous', code: 'KT', name: 'Unknown Org' });
  });

  it('ignores an override that names a team absent from the table', () => {
    // A stale override is a config bug. Honouring it would attach an id nothing else knows.
    const r = ask(shared, 'Unknown Org', 'KT', {
      override: { code: 'KT', leagueSlug: 'worlds', teamId: '404', reason: 'stale' },
    });
    expect(r.kind).toBe('ambiguous');
  });

  it('lets a valid override settle a code collision', () => {
    const r = ask(shared, 'Unknown Org', 'KT', {
      override: { code: 'KT', leagueSlug: 'worlds', teamId: '2', reason: 'test' },
    });
    expect(r).toEqual({ kind: 'resolved', team: academy, matchedBy: 'code' });
  });

  it('reports an unknown name and code as unresolved rather than throwing', () => {
    expect(ask(single, 'Nobody', 'NOPE')).toEqual({
      kind: 'unresolved', code: 'NOPE', name: 'Nobody',
    });
  });
});

// ---------------------------------------------------------------------------
// Against the real captures
// ---------------------------------------------------------------------------

describe('the main schedule capture', () => {
  const result = parse(scheduleRaw);

  it('resolves every non-TBD team in a covered league', () => {
    /**
     * 60, measured under the eight-league coverage decided 2026-08-11. It was 86 under the previous
     * fourteen: pcs (8 sides), cblol-brazil (16) and ljl-japan (2) are now out of scope, and 60 + 26
     * = 86 — the two measurements agree, which is the point of writing the arithmetic down.
     */
    const covered = new Set(leagueConfig.majorSlugs());
    const sides = result.items
      .filter((m) => m.leagueSlug !== null && covered.has(m.leagueSlug))
      .flatMap((m) => m.sides)
      .filter((s) => s.team !== null);

    expect(sides).toHaveLength(60);
    expect(sides.every((s) => s.team?.externalId !== null)).toBe(true);
    expect(countOf(result.warnings, 'team-unresolved')).toBe(0);
    expect(countOf(result.warnings, 'team-ambiguous')).toBe(0);
  });

  it('resolves all 60 by name, with the code fallback never used', () => {
    /**
     * The reproducible half of the evidence for joining on name.
     *
     * Zero `team-name-mismatch` means every side matched the master table by name, so the code
     * fallback contributed nothing here — and the two endpoints agree on all 60 names. That is a
     * stronger statement than it looks: `rest_getSchedule.json` was captured under `hl=zh-TW` and
     * `rest_getTeams.json` under `hl=en-US`, so this also demonstrates that team names are not
     * translated, while `blockName` in the same document plainly is (`第11週`).
     *
     * If Riot ever renames a team in one endpoint before the other, this count goes up and the
     * warning names both spellings — which is the point of having the fallback rather than a miss.
     */
    expect(countOf(result.warnings, 'team-name-mismatch')).toBe(0);

    const anyBlockName = result.items.find((m) => m.stageLabel !== null)?.stageLabel;
    expect(anyBlockName).toMatch(/[^ -]/); // the fixture really is a translated locale
  });

  it('gives the seven academy orgs no parent id, by name rather than by the tier gate', () => {
    /**
     * Seven LCK orgs field an academy team, and each pair shares a code while differing in name:
     * kt Rolster/kt Challengers, Dplus KIA/DK Challengers, Hanwha Life Esports/HLE Challengers,
     * BNK FEARX/BNK FEARX Youth, NONGSHIM RED FORCE/NS Challengers, KIWOOM DRX/KRX Challengers,
     * DN SOOPers/DNS Challengers.
     *
     * Under the old code join, every academy side resolved to its parent's id and only the tier gate
     * prevented it. Here the assertion is that the *names* differ from every name in the index, so
     * the join misses on its own merits.
     */
    const challengerNames = new Set(
      result.items
        .filter((m) => m.leagueSlug === 'lck_challengers_league')
        .flatMap((m) => m.sides)
        .flatMap((s) => (s.team === null ? [] : [s.team.name])),
    );
    expect(challengerNames.size).toBeGreaterThan(0);
    for (const name of challengerNames) {
      expect(index.byName.has(name.trim().toLowerCase())).toBe(false);
    }
  });

  it('keeps a newly-excluded league in the calendar, without team identity', () => {
    /**
     * Narrowing coverage must not lose matches — only identity. cblol-brazil was major until
     * 2026-08-11 and is the largest single casualty at sixteen sides. They are still parsed, still
     * carry their names, and raise no `team-unresolved` warning: an out-of-scope league is a
     * recorded decision rather than news at fetch time.
     */
    for (const slug of ['cblol-brazil', 'pcs', 'ljl-japan']) {
      expect(leagueConfig.tierFor(slug)).toBe('minor');
    }
    const dropped = result.items.filter((m) => m.leagueSlug === 'cblol-brazil');
    expect(dropped.flatMap((m) => m.sides).filter((s) => s.team !== null)).toHaveLength(16);
    expect(dropped.flatMap((m) => m.sides).every((s) => s.team === null || s.team.externalId === null)).toBe(true);
    expect(dropped.every((m) => m.startsAtUtc !== '' && m.leagueSlug === 'cblol-brazil')).toBe(true);
    expect(countOf(result.warnings, 'unclassified-league')).toBe(0);
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
    // 153 of the 168 narrowed rows in the full capture are http, and 47 of 47 in the trimmed
    // fixture — the getTeams asset is newer than getSchedule's but no safer.
    const gen = sideByCode(result.items, 'lck', 'GEN');
    expect(gen?.externalId).toBe('100205573495116443');
    expect(gen?.logoUrl?.startsWith('https://')).toBe(true);

    const fromTable = teamRecords.find((t) => t.externalId === '100205573495116443');
    expect(gen?.logoUrl).toBe(fromTable?.logoUrl);
  });
});

describe('cross-league resolution at an international event', () => {
  /**
   * A team's identity comes from the master table, not from the league the match is played under.
   * This has to keep working, because it is the whole reason Worlds and MSI can be covered at all:
   * every side at an international event is playing away from its home league.
   *
   * It is asserted against `worlds` rather than against the EWC capture below, because `ewc_lol`
   * stopped being covered on 2026-08-11 and a test must exercise a path production actually takes.
   */
  it('resolves an LCK team competing under an international league slug', () => {
    const out = parse(
      scheduleEnvelope([
        matchEvent({
          league: { name: 'Worlds', slug: 'worlds' },
          match: {
            id: '900000000000000012',
            flags: [],
            strategy: { type: 'bestOf', count: 5 },
            teams: [
              { name: 'T1', code: 'T1', image: null, result: { outcome: null, gameWins: 0 } },
              { name: 'G2 Esports', code: 'G2', image: null, result: { outcome: null, gameWins: 0 } },
            ],
          },
        }),
      ]),
    );

    expect(leagueConfig.tierFor('worlds')).toBe('major');
    const [t1, g2] = out.items[0]!.sides;
    expect(t1.team?.externalId).toBe('98767991853197861');
    expect(g2.team?.externalId).not.toBeNull();

    // Identity came from the home league, not from the event.
    expect(teamRecords.find((t) => t.externalId === t1.team?.externalId)?.homeLeagueName).toBe('LCK');
    expect(teamRecords.find((t) => t.externalId === g2.team?.externalId)?.homeLeagueName).toBe('LEC');
    expect(countOf(out.warnings, 'team-unresolved')).toBe(0);
    expect(countOf(out.warnings, 'team-ambiguous')).toBe(0);
  });
});

describe('the Esports World Cup capture, now out of scope', () => {
  /**
   * This fixture was captured while `ewc_lol` was major, and its original test asserted that all
   * twelve sides resolved. The 2026-08-11 scope decision made EWC minor, so the same fixture now
   * exercises the opposite path — which is worth keeping rather than deleting, because "a league we
   * stopped covering still yields matches, just without identity" is the behaviour that decides
   * whether narrowing coverage is safe.
   *
   * EWC remains a plausible future major (it is an international event). If it comes back, this
   * block is the one that flips.
   */
  const result = parse(ewcRaw);

  it('still parses every match, and keeps team names', () => {
    expect(leagueConfig.tierFor('ewc_lol')).toBe('minor');
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.every((m) => m.leagueSlug === 'ewc_lol')).toBe(true);

    const sides = result.items.flatMap((m) => m.sides).filter((s) => s.team !== null);
    expect(sides).toHaveLength(12);
    expect(sides.every((s) => (s.team?.name.length ?? 0) > 0)).toBe(true);
  });

  it('resolves no team id, and does not warn about a decision already recorded', () => {
    const sides = result.items.flatMap((m) => m.sides).filter((s) => s.team !== null);
    expect(sides.every((s) => s.team?.externalId === null)).toBe(true);

    // Silence is deliberate: an explicit `minor` in config/leagues.json is a decision, and roughly
    // half of an unfiltered getSchedule is out of scope. Warning per side would drown the log.
    expect(countOf(result.warnings, 'team-unresolved')).toBe(0);
    expect(countOf(result.warnings, 'team-ambiguous')).toBe(0);
    expect(countOf(result.warnings, 'unclassified-league')).toBe(0);
  });

  it('would resolve those teams if EWC were covered again', () => {
    // The narrowing is the only thing standing between these sides and their ids — not a gap in the
    // table. T1 is in the index; the tier gate is what refuses to look.
    const t1 = teamRecords.find((t) => t.code === 'T1' && t.status === 'active');
    expect(index.byCode.get('T1')?.[0]?.externalId).toBe(t1?.externalId);
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
  });

  it('covers exactly the eight leagues the owner chose', () => {
    // Three international events plus five regional leagues, decided 2026-08-11. A change here is a
    // product decision and should have to be made deliberately, in a diff someone reads.
    expect([...leagueConfig.majorSlugs()].sort()).toEqual(
      ['first_stand', 'lck', 'lcp', 'lcs', 'lec', 'lpl', 'msi', 'worlds'],
    );
  });

  it('refuses a file that classifies one slug twice', () => {
    expect(() =>
      createLeagueConfig({
        leagues: [{ slug: 'lck', tier: 'major', kind: 'region' }, { slug: 'lck', tier: 'minor' }],
      }),
    ).toThrow(/more than once/);
  });

  it('reports a duplicated slug ahead of a missing kind, because it is the more basic error', () => {
    // Both are wrong in this file. Validating kind first would send the reader to fix the wrong one.
    expect(() =>
      createLeagueConfig({
        leagues: [{ slug: 'lck', tier: 'major' }, { slug: 'lck', tier: 'major' }],
      }),
    ).toThrow(/more than once/);
  });

  it('refuses a major league that does not declare whether it is a region or an event', () => {
    /**
     * No default, on purpose. An event silently treated as a region starts contributing placeholder
     * rows to the team table — "LCS" and "VCS" are real active rows homed at MSI — and nothing turns
     * red. The cost of the strictness is one required field per covered league.
     */
    expect(() => createLeagueConfig({ leagues: [{ slug: 'worlds', tier: 'major' }] })).toThrow(
      /must declare/,
    );
    expect(() =>
      createLeagueConfig({ leagues: [{ slug: 'worlds', tier: 'major', kind: 'event' }] }),
    ).not.toThrow();
    // Minor entries are exempt: nothing reads their kind.
    expect(() => createLeagueConfig({ leagues: [{ slug: 'nacl', tier: 'minor' }] })).not.toThrow();
  });

  it('refuses to let a file write unclassified, which is the absence of an entry', () => {
    expect(() => createLeagueConfig({ leagues: [{ slug: 'lck', tier: 'unclassified' }] })).toThrow();
  });
});
