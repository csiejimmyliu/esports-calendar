/**
 * Riot identifier handling. Riot-family only — this file must never be imported from src/core.
 *
 * The GraphQL `homeEvents` operation returns *composite* team ids of the form
 * `"{matchId}:{teamId}"`, while every REST endpoint returns a plain id. Confirmed by two
 * endpoints agreeing on the same team:
 *
 *   GraphQL homeEvents   "116566854547835328:99566404850008779"
 *   REST getEventDetails                    "99566404850008779"
 *
 * Using the composite string as a team key creates a new "team" per match, which quietly turns
 * one team into hundreds and breaks every team subscription.
 *
 * Splitting belongs here and not in src/core because being composite is a property of one
 * endpoint of one source. The moment core knows ids can be composite, the adapter boundary has
 * leaked (NFR-3) — and it would be leaking a shape that is already untrue for two of the three
 * probed sources.
 */

export type RiotTeamId =
  /** A usable team identifier. */
  | { kind: 'team'; teamId: string }
  /**
   * Riot's TBD sentinel. The team half of the composite is `0`, and the accompanying object has
   * `code: "TBD"` and `result: null`. Callers map this to `team: null` — never to a team whose
   * id happens to be "0", which would collapse every undecided opponent in the system into one
   * shared phantom team.
   */
  | { kind: 'tbd' }
  /** A shape we do not recognise. Warn; do not guess which segment is the team. */
  | { kind: 'unknown'; raw: string };

export function splitRiotTeamId(raw: string): RiotTeamId {
  const segments = raw.split(':');

  if (segments.length === 1) {
    // Plain id. Every REST endpoint, LoL and VALORANT alike, returns this form.
    const only = segments[0] ?? '';
    if (only === '') return { kind: 'unknown', raw };
    return only === '0' ? { kind: 'tbd' } : { kind: 'team', teamId: only };
  }

  if (segments.length === 2) {
    const teamId = segments[1] ?? '';
    if (teamId === '') return { kind: 'unknown', raw };
    return teamId === '0' ? { kind: 'tbd' } : { kind: 'team', teamId };
  }

  // Three or more segments is a shape nothing has emitted. Taking the last one would be a guess
  // that works right up until it silently doesn't.
  return { kind: 'unknown', raw };
}
