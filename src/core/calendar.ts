/**
 * Calendar composition — SPEC §2 FR-1.
 *
 *   calendar(u) = { m | (derived(u, m) ∨ included(u, m)) ∧ ¬excluded(u, m) }
 *
 *   derived(u, m) ⟺ ∃ f ∈ follow(u) : f.target is m's league,
 *                                     or f.target is a team on either side of m
 *
 * Pure, DB-free, clock-free, table-tested — the same discipline as `src/sync/diff.ts`, and for the
 * same reason: this is the product's central behaviour and the rules that make it correct are the
 * ones nobody notices are missing until a user's calendar is wrong. Every acceptance criterion for
 * stage 2a is a case in `tests/calendar.test.ts`.
 *
 * What this file does NOT do, on purpose:
 *
 *   - It does not sort. Ordering is the query's job (`src/db/queries/overview.ts` orders by
 *     `starts_at_utc`); input order is preserved so a caller that already sorted stays sorted.
 *   - It does not filter by time. "Upcoming" is a view concern, and FR-1 says nothing about it —
 *     a finished match a user picked is still on their calendar.
 *   - It does not hide scores. FR-3 (spoiler-free) is a render decision, not a membership one.
 */

import type { Follow, Match, Selection } from './types.js';

export interface CalendarInputs {
  follows: readonly Follow[];
  selections: readonly Selection[];
  matches: readonly Match[];
}

/**
 * Whether any follow reaches this match.
 *
 * The team branch is why FR-1 rule 7 (a TBD side resolving pulls the match in) needs no backfill
 * job and no user action: `sides[n].team` simply stops being null on some later sync, and the next
 * read of this function returns a different answer. Membership is recomputed, never stored.
 *
 * `leagueId` is nullable on `Match` (a source may have no league tier — see the type), so a league
 * follow must not match it by both being null.
 */
function isDerived(match: Match, follows: readonly Follow[]): boolean {
  return follows.some((f) => {
    if (f.targetType === 'league') {
      return match.leagueId !== null && match.leagueId === f.targetId;
    }
    return match.sides.some((side) => side.team !== null && side.team.id === f.targetId);
  });
}

/**
 * The matches on this user's calendar, in the order they were given.
 *
 * `selections` may legitimately mention matches absent from `matches` — FR-1 rule 5: an `excluded`
 * row for a match nothing derives is inert, and is kept anyway, so that re-following the team
 * restores the user's earlier intent rather than resurrecting a match they had removed. Such rows
 * are simply never consulted here. Keeping them is the persistence layer's obligation
 * (`src/db/queries/selections.ts`), not this function's.
 */
export function composeCalendar({ follows, selections, matches }: CalendarInputs): Match[] {
  const stateByMatch = new Map(selections.map((s) => [s.matchId, s.state]));

  return matches.filter((match) => {
    const explicit = stateByMatch.get(match.id);

    // An explicit action always beats a derived one (FR-1 rule 1), in both directions: `excluded`
    // removes a match a follow would have added, `included` adds one no follow covers. Checking
    // the explicit state first is what makes that true, rather than a special case bolted on after.
    if (explicit === 'excluded') return false;
    if (explicit === 'included') return true;

    return isDerived(match, follows);
  });
}
