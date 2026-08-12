/**
 * Whether an incoming match differs from what is stored in a way a user would notice.
 *
 * Pure, DB-free, table-tested. This is the substance of `match.revision` (SPEC §5: "bumped only
 * on user-visible change, so a calendar client is told to update exactly when it should"), which
 * drives ICS `SEQUENCE`. Getting this wrong in the permissive direction (bumping on every sync)
 * would mean every subscribed calendar re-notifies on an hourly cadence for matches whose visible
 * content never changed; getting it wrong in the strict direction would mean a real reschedule
 * goes unnoticed.
 */

import type { MatchState } from '../core/types.js';

export interface MatchSnapshot {
  startsAtUtc: string;
  state: MatchState;
  seriesLength: number | null;
  stageLabel: string | null;
  /** Resolved team id per side; null for TBD or an unresolved team. Position matches SourceMatch.sides. */
  sideTeamIds: readonly [string | null, string | null];
}

/**
 * `score` and `gamesPlayed` are deliberately absent from this comparison. FR-3 (spoiler-free) is
 * exactly why: a score changing is the normal, frequent, *invisible-by-default* thing that
 * happens to a match, and SPEC's ICS section is explicit that ICS content must stay spoiler-free.
 * Bumping SEQUENCE on every score update would tell a calendar client to re-notify about an event
 * whose visible content did not change.
 */
export function visibleChange(existing: MatchSnapshot, incoming: MatchSnapshot): boolean {
  return (
    existing.startsAtUtc !== incoming.startsAtUtc ||
    existing.state !== incoming.state ||
    existing.seriesLength !== incoming.seriesLength ||
    existing.stageLabel !== incoming.stageLabel ||
    existing.sideTeamIds[0] !== incoming.sideTeamIds[0] ||
    existing.sideTeamIds[1] !== incoming.sideTeamIds[1]
  );
}
