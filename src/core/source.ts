/**
 * Source adapter interface — DRAFT.
 *
 * This is a proposal, not a decision. Stage 0's job is to challenge it against the three
 * probed sources (docs/sources/) and report where it does not fit. A place it does not fit
 * is a finding, not an obstacle to work around.
 *
 * Every design choice below is traceable to something a real source does.
 */

import type { GameSlug, League, Match, Tournament } from './types.js';

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/**
 * Declared rather than assumed.
 *
 * The sources differ in *capability*, not only in field names, so pretending uniformity
 * pushes the difference into runtime nulls. Declaring it lets the sync layer branch honestly.
 */
export interface SourceCapabilities {
  /** Can return every match in one call with no scope. Riot: true. BLAST: false. */
  globalSchedule: boolean;

  /** Supplies match state directly. Riot: true. BLAST: false (must be inferred). */
  explicitState: boolean;

  /** Supplies per-match stream URLs. BLAST: true. Riot: false — falls back to League.defaultStreamUrl. */
  streamUrls: boolean;

  /** Has a durable league tier above tournaments. Riot: true. BLAST: false. */
  leagues: boolean;

  /** Supports narrowing by date range. Riot: true (cursors). BLAST: false (whole tournament). */
  timeWindow: boolean;
}

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

/**
 * A unit of fetching.
 *
 * This exists because BLAST has no global schedule endpoint — matches are only reachable as
 * `/tournaments/{slug}/matches`, so a slug must be known before anything can be fetched.
 * Riot needs no such thing.
 *
 * Rather than special-casing BLAST, the interface is shaped to the weaker capability:
 * enumerate scopes, then fetch per scope. Riot returns a single global scope and ignores it.
 */
export interface Scope {
  /** Stable within a source. Riot: "global". BLAST: the tournament slug. */
  key: string;
  label: string;
  /**
   * Expected to yield at least one match. Used by the semantic canary: a scope that
   * returns zero matches when this is true is an alert, not an empty result.
   */
  expectsMatches: boolean;
}

export interface TimeWindow {
  fromUtc: string;
  toUtc: string;
}

// ---------------------------------------------------------------------------
// Fetch results
// ---------------------------------------------------------------------------

/**
 * Fetches report emptiness explicitly.
 *
 * BLAST returns HTTP 200 and `[]` for an unknown tournament slug — indistinguishable from a
 * real tournament with nothing scheduled. An adapter that returns a bare array makes that
 * ambiguity invisible. Forcing the distinction upward is the point.
 */
export interface FetchResult<T> {
  items: T[];
  /** Set when the source responded successfully but the adapter believes the result is suspect. */
  suspectEmpty: boolean;
  /** Raw payload size, request count, etc. For source_health. */
  diagnostics: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export interface SourceAdapter {
  /** Stable identifier: "riot-lol", "riot-val", "blast-cs". */
  readonly id: string;
  readonly game: GameSlug;
  readonly capabilities: SourceCapabilities;

  /**
   * Enumerate what can be fetched.
   *
   * Riot: one global scope, or one per league.
   * BLAST: one per tournament — and discovering those slugs is an unsolved problem
   * (see docs/sources/cs2-blast.md). Until it is solved, this may read from a
   * manually maintained list, which is an acceptable v1 answer.
   */
  listScopes(): Promise<FetchResult<Scope>>;

  /** `window` is advisory: sources with `timeWindow: false` return everything in scope. */
  fetchMatches(scope: Scope, window?: TimeWindow): Promise<FetchResult<Match>>;

  /** Only meaningful when `capabilities.leagues` is true. */
  fetchLeagues?(): Promise<FetchResult<League>>;

  fetchTournaments?(scope: Scope): Promise<FetchResult<Tournament>>;
}

// ---------------------------------------------------------------------------
// Notes for Stage 0
// ---------------------------------------------------------------------------

/**
 * Known tensions in this draft. Resolve or report:
 *
 * 1. Riot's GraphQL returns composite team ids ("{matchId}:{teamId}") while every Riot REST
 *    endpoint returns plain ids. Where does splitting belong — adapter or a shared helper?
 *
 * 2. BLAST needs two endpoints to produce one Match (state lives only in /brackets).
 *    Does fetchMatches hide that, or should the interface admit multi-request fetches?
 *
 * 3. Riot emits `type: "show"` events with no `match` object at all. Filtering belongs in the
 *    adapter, but unknown `type` values must warn rather than be dropped silently.
 *
 * 4. Error envelopes differ per source: Riot returns HTTP 200 with `{"errors":[…]}`; BLAST
 *    returns 404 with `{code,message}` and 200 with `[]`. There is no shared error shape to
 *    detect generically — each adapter owns its own detection.
 *
 * 5. Timestamps are not uniformly zoned even within one BLAST object (`scheduledAt` has Z,
 *    `tournament.startDate` does not). Parse per field.
 */
