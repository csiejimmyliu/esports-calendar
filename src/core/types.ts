/**
 * Normalized domain model.
 *
 * Every field here exists because a probed source forced it. See docs/sources/.
 * Nothing in this file may reference a source's vocabulary.
 */

export type GameSlug = 'lol' | 'val' | 'cs';

/** Opaque source-assigned id. Riot uses numeric snowflakes, BLAST uses UUIDs. Never parse it. */
export type ExternalId = string;

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export interface Team {
  /** Our canonical id. Source ids live in ExternalRef. */
  id: string;
  game: GameSlug;
  name: string;
  /** Short code: "LNG", "MOUZ". Not unique across leagues — never use as a key. */
  code: string | null;
  logoUrl: string | null;
}

/**
 * Optional by design. Riot has league -> tournament -> match; BLAST has only
 * tournament -> stage -> match, with `circuit` being a year tag, not a league.
 * See docs/sources/cs2-blast.md.
 */
export interface League {
  id: string;
  game: GameSlug;
  slug: string;
  name: string;
  region: string | null;
  logoUrl: string | null;
  /**
   * Ours to maintain. No probed source exposes a usable tier signal:
   * Riot's `priority` is 1 for every league and `displayPriority` is per-request UI state.
   */
  tier: 'major' | 'minor' | 'unclassified';
  /** Fallback stream when the source supplies none (Riot supplies none). */
  defaultStreamUrl: string | null;
}

export interface Tournament {
  id: string;
  game: GameSlug;
  /** Null for sources without a league tier. */
  leagueId: string | null;
  name: string;
  startsOn: string | null;
  endsOn: string | null;
}

// ---------------------------------------------------------------------------
// Match
// ---------------------------------------------------------------------------

export type MatchState = 'unstarted' | 'inProgress' | 'completed' | 'cancelled';

/**
 * A side of a match. `team: null` means the opponent is undecided.
 *
 * TBD is first-class here because the sources disagree entirely on how to express it:
 * Riot uses a sentinel object (code "TBD", id suffix ":0"); BLAST uses a plain null.
 * Neither convention may leak past the adapter.
 */
export interface MatchSide {
  team: Team | null;
  /** Games won in this series. Null before play begins. */
  score: number | null;
}

export interface Match {
  id: string;
  game: GameSlug;
  leagueId: string | null;
  tournamentId: string | null;

  startsAtUtc: string;
  state: MatchState;

  /**
   * seriesLength and gamesPlayed are separate on purpose.
   *
   * A Bo3 that ends 2-0: Riot returns three games with the third marked "unneeded";
   * BLAST returns an array of two. seriesLength is 3 in both cases, gamesPlayed is 2.
   * On Riot the two happen to be equal for completed series, which is why a Riot-only
   * implementation never surfaces the distinction.
   */
  seriesLength: number | null;
  gamesPlayed: number;

  sides: [MatchSide, MatchSide];

  /** Riot's localized blockName, BLAST's stage.name. Display only — never a key. */
  stageLabel: string | null;

  /** Present when the source supplies one (BLAST does, Riot does not). */
  streamUrl: string | null;

  /** Bumped only on user-visible change. Drives ICS SEQUENCE. */
  revision: number;
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Crosswalk between our canonical ids and every source's identifiers.
 *
 * Keyed by (sourceId, game, externalId). The game dimension is deliberate: Riot's LoL and
 * VALORANT ids appear to come from one generator, but that is an unverified assumption and
 * one extra column buys it out.
 *
 * BLAST embeds Liquipedia page ids on teams
 * (metadata.references.liquipedia.pageId) — store those here too, as a
 * ready-made bridge for cross-source identity.
 */
export interface ExternalRef {
  entityType: 'league' | 'tournament' | 'team' | 'match';
  entityId: string;
  sourceId: string;
  game: GameSlug;
  externalId: ExternalId;
  /** Set manually when automatic matching is wrong. Renames and merges are normal. */
  manualOverride: boolean;
}
