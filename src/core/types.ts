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
// The source layer
// ---------------------------------------------------------------------------

/**
 * What an adapter actually returns.
 *
 * The entities above are the *resolved* domain model: their `id` fields are our canonical ids,
 * which only exist once the crosswalk (ExternalRef) has run. An adapter has no database and must
 * never acquire one (NFR-2), so it cannot know a canonical id. Given only the domain types, an
 * adapter would have to either invent ids — and reinvent them on the next run, breaking idempotent
 * ingestion — or read the DB, breaking source isolation.
 *
 * So adapters emit `Source*` records keyed by the source's own external id, and the sync layer
 * (Stage 1) resolves those into the domain model.
 *
 * `revision` is deliberately absent here: it is a property of what we have already stored, not of
 * what a source said, and only the sync layer can compute it.
 */

export interface SourceTeam {
  /**
   * Null when the source cannot identify teams at all. Riot REST `getSchedule` returns team
   * `name` and `code` but no id anywhere in the document — see docs/sources/lolesports-rest.md.
   * A source in that state cannot back team subscriptions (FR-1); it declares
   * `capabilities.teamIdentity: false` so the sync layer knows without inspecting rows.
   */
  externalId: ExternalId | null;
  name: string;
  /** "GEN", "MOUZ". Collides across leagues (TL, KC, FX all recur) — never a key. */
  code: string | null;
  logoUrl: string | null;
}

/** `team: null` means TBD. Riot's sentinel object and BLAST's plain null both normalize to this. */
export interface SourceSide {
  team: SourceTeam | null;
  score: number | null;
}

export interface SourceMatch {
  externalId: ExternalId;
  game: GameSlug;

  /**
   * Riot REST `getSchedule` carries `league: {name, slug}` with no id, so league identity has to
   * come from a second endpoint. When that endpoint is unavailable the match is still returned
   * with `leagueExternalId: null` and a degradation warning — a partial result beats no result.
   */
  leagueExternalId: ExternalId | null;
  /** The only league handle some endpoints expose. Display and matching, never a crosswalk key. */
  leagueSlug: string | null;
  /** Null where the source has no tournament tier in this response (Riot REST `getSchedule`). */
  tournamentExternalId: ExternalId | null;

  /** ISO 8601, always explicitly UTC. See parseUtcInstant — zone markers are never assumed. */
  startsAtUtc: string;
  state: MatchState;

  /** See Match: separate from gamesPlayed on purpose. */
  seriesLength: number | null;
  gamesPlayed: number;

  sides: [SourceSide, SourceSide];

  /** Riot's localized blockName, BLAST's stage.name. Display only. */
  stageLabel: string | null;

  /** Only when the source supplies one. Riot supplies none — see League.defaultStreamUrl. */
  streamUrl: string | null;
}

/**
 * Note the absence of `tier` and `defaultStreamUrl`. No probed source exposes a usable tier
 * signal (Riot's `priority` is 1 for all 45 leagues) and Riot exposes no streams, so both are
 * ours to maintain — an adapter must not be able to claim otherwise.
 */
export interface SourceLeague {
  externalId: ExternalId;
  game: GameSlug;
  slug: string;
  name: string;
  region: string | null;
  logoUrl: string | null;
}

export interface SourceTournament {
  externalId: ExternalId;
  game: GameSlug;
  leagueExternalId: ExternalId | null;
  name: string;
  startsOn: string | null;
  endsOn: string | null;
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
