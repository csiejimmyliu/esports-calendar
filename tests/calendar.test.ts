/**
 * Stage 2a's acceptance criterion (SPEC §8): the FR-1 rules as a pure function, table-driven.
 *
 * The four cases SPEC names by hand each have their own `it`, named after the rule rather than
 * after the code, so a failure says which product requirement broke.
 */

import { describe, expect, it } from 'vitest';

import { composeCalendar } from '../src/core/calendar.js';
import type { Follow, Match, Selection, Team } from '../src/core/types.js';

const T1: Team = { id: 'team-t1', game: 'lol', name: 'T1', code: 'T1', logoUrl: null };
const GEN: Team = { id: 'team-gen', game: 'lol', name: 'Gen.G', code: 'GEN', logoUrl: null };
const HLE: Team = { id: 'team-hle', game: 'lol', name: 'Hanwha Life Esports', code: 'HLE', logoUrl: null };

function match(id: string, over: Partial<Match> = {}): Match {
  return {
    id,
    game: 'lol',
    leagueId: 'league-lck',
    tournamentId: null,
    startsAtUtc: '2026-08-20T08:00:00Z',
    state: 'unstarted',
    seriesLength: 3,
    gamesPlayed: 0,
    sides: [
      { team: T1, score: null },
      { team: GEN, score: null },
    ],
    stageLabel: 'Week 11',
    streamUrl: null,
    revision: 1,
    ...over,
  };
}

const FOLLOW_LCK: Follow = { targetType: 'league', targetId: 'league-lck' };
const FOLLOW_T1: Follow = { targetType: 'team', targetId: 'team-t1' };

function ids(matches: Match[]): string[] {
  return matches.map((m) => m.id);
}

describe('composeCalendar — derivation', () => {
  const m1 = match('m1');
  const m2 = match('m2', { leagueId: 'league-lec', sides: [{ team: HLE, score: null }, { team: null, score: null }] });

  const cases: [string, Follow[], string[]][] = [
    ['no follows and no picks yields an empty calendar', [], []],
    ['a league follow derives that league only', [FOLLOW_LCK], ['m1']],
    ['a team follow derives matches on either side', [FOLLOW_T1], ['m1']],
    ['two follows union rather than intersect', [FOLLOW_LCK, { targetType: 'team', targetId: 'team-hle' }], ['m1', 'm2']],
    ['a follow of something nothing matches derives nothing', [{ targetType: 'team', targetId: 'team-nobody' }], []],
  ];

  it.each(cases)('%s', (_label, follows, expected) => {
    expect(ids(composeCalendar({ follows, selections: [], matches: [m1, m2] }))).toEqual(expected);
  });

  it('does not let a league follow match a match with no league', () => {
    // Match.leagueId is nullable — a source may supply no league tier, and Riot legitimately
    // returns null under a fetchLeagues degradation. `null === null` must not read as a match.
    const orphan = match('m-orphan', { leagueId: null });
    const follows: Follow[] = [{ targetType: 'league', targetId: 'league-lck' }];
    expect(ids(composeCalendar({ follows, selections: [], matches: [orphan] }))).toEqual([]);
  });

  it('preserves input order rather than imposing its own', () => {
    const matches = [match('c'), match('a'), match('b')];
    expect(ids(composeCalendar({ follows: [FOLLOW_LCK], selections: [], matches }))).toEqual(['c', 'a', 'b']);
  });
});

describe('composeCalendar — FR-1 rule 1: an explicit action beats a derived one', () => {
  it('excludes one match of a followed team without touching the rest — SPEC §8 case 1', () => {
    const kept = match('m-kept');
    const dropped = match('m-dropped');
    const selections: Selection[] = [{ matchId: 'm-dropped', state: 'excluded' }];

    const result = composeCalendar({ follows: [FOLLOW_T1], selections, matches: [kept, dropped] });
    expect(ids(result)).toEqual(['m-kept']);
  });

  it('includes a match no follow covers', () => {
    const foreign = match('m-lec', {
      leagueId: 'league-lec',
      sides: [
        { team: HLE, score: null },
        { team: null, score: null },
      ],
    });
    const selections: Selection[] = [{ matchId: 'm-lec', state: 'included' }];

    expect(ids(composeCalendar({ follows: [FOLLOW_T1], selections, matches: [foreign] }))).toEqual(['m-lec']);
  });
});

describe('composeCalendar — FR-1 rule 3: unfollowing does not delete picks', () => {
  it('keeps hand-picked matches after the follow is gone — SPEC §8 case 2', () => {
    // The user followed T1, picked one match by hand, then unfollowed. The pick was a separate
    // explicit statement and survives; the merely-derived match does not.
    const picked = match('m-picked');
    const derivedOnly = match('m-derived');
    const selections: Selection[] = [{ matchId: 'm-picked', state: 'included' }];

    const whileFollowing = composeCalendar({ follows: [FOLLOW_T1], selections, matches: [picked, derivedOnly] });
    expect(ids(whileFollowing)).toEqual(['m-picked', 'm-derived']);

    const afterUnfollow = composeCalendar({ follows: [], selections, matches: [picked, derivedOnly] });
    expect(ids(afterUnfollow)).toEqual(['m-picked']);
  });
});

describe('composeCalendar — FR-1 rule 6: overrides key on match_id, never on time', () => {
  it('carries the selection through a reschedule with no fixup pass — SPEC §8 case 3', () => {
    const before = match('m-resched', { startsAtUtc: '2026-08-20T08:00:00Z' });
    const after = match('m-resched', { startsAtUtc: '2026-09-01T11:00:00Z', revision: 2 });
    const selections: Selection[] = [{ matchId: 'm-resched', state: 'excluded' }];

    expect(ids(composeCalendar({ follows: [FOLLOW_LCK], selections, matches: [before] }))).toEqual([]);
    expect(ids(composeCalendar({ follows: [FOLLOW_LCK], selections, matches: [after] }))).toEqual([]);
  });
});

describe('composeCalendar — FR-1 rule 7: TBD opponents resolve into the calendar by themselves', () => {
  it('pulls the match in once a side resolves, with no user action — SPEC §8 case 4', () => {
    // A Worlds match with an undecided side. Following T1 must not surface it while the side is
    // TBD, and must surface it the moment Riot fills the side in — no backfill job, no re-pick.
    const tbd = match('m-worlds', {
      leagueId: 'league-worlds',
      sides: [
        { team: GEN, score: null },
        { team: null, score: null },
      ],
    });
    const resolved = match('m-worlds', {
      leagueId: 'league-worlds',
      sides: [
        { team: GEN, score: null },
        { team: T1, score: null },
      ],
    });

    expect(ids(composeCalendar({ follows: [FOLLOW_T1], selections: [], matches: [tbd] }))).toEqual([]);
    expect(ids(composeCalendar({ follows: [FOLLOW_T1], selections: [], matches: [resolved] }))).toEqual(['m-worlds']);
  });
});

describe('composeCalendar — FR-1 rules 4 and 5: excluded rows outlive what produced them', () => {
  it('keeps an excluded match excluded after it has finished', () => {
    // Rule 4. Deleting the row once the match is over would silently rewrite the user's past
    // calendar — a match they removed would reappear in a week view of last month.
    const finished = match('m-done', { state: 'completed', gamesPlayed: 2, sides: [
      { team: T1, score: 0 },
      { team: GEN, score: 2 },
    ] });
    const selections: Selection[] = [{ matchId: 'm-done', state: 'excluded' }];

    expect(ids(composeCalendar({ follows: [FOLLOW_LCK], selections, matches: [finished] }))).toEqual([]);
  });

  it('leaves an excluded row inert while nothing derives the match, and honours it again on re-follow', () => {
    // Rule 5. The row is dormant, not wrong: re-following the team must restore the user's earlier
    // intent, not resurrect a match they had removed.
    const m = match('m-inert');
    const selections: Selection[] = [{ matchId: 'm-inert', state: 'excluded' }];

    expect(ids(composeCalendar({ follows: [], selections, matches: [m] }))).toEqual([]);
    expect(ids(composeCalendar({ follows: [FOLLOW_T1], selections, matches: [m] }))).toEqual([]);
  });

  it('ignores selections naming matches absent from the input', () => {
    const selections: Selection[] = [
      { matchId: 'm-gone', state: 'excluded' },
      { matchId: 'm-also-gone', state: 'included' },
    ];
    expect(ids(composeCalendar({ follows: [FOLLOW_LCK], selections, matches: [match('m1')] }))).toEqual(['m1']);
  });
});
