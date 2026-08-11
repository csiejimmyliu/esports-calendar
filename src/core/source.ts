/**
 * Source adapter interface — FINAL for Stage 0.
 *
 * Supersedes the Stage 0 draft. Every change below is traceable to something a probed source
 * actually does; where a source did not fit the draft, the draft moved. See docs/sources/.
 *
 * Changes from the draft, with the source that forced each:
 *
 * - Adapters return `Source*` records, not domain entities. An adapter has no crosswalk and must
 *   not have a database (NFR-2), so it cannot produce a canonical id. See src/core/types.ts.
 * - `SourceCapabilities.globalSchedule` removed — it is `listScopes()` returning one scope, and
 *   two representations of one fact eventually disagree.
 * - `SourceCapabilities.leagues` removed — it duplicated `fetchLeagues !== undefined`.
 * - `teamIdentity` added — Riot REST `getSchedule` returns no team ids at all, which is a
 *   capability difference, not a field-name difference (docs/sources/lolesports-rest.md).
 * - `scopeDiscovery` added — the sync layer needs to know a scope list is hand-maintained,
 *   because a hand-maintained list fails by omission and nothing turns red (BLAST).
 * - `Scope.expectsMatches` removed, replaced by adapter-level canaries — see SourceCanary.
 * - `Scope` gained provenance and a validity window, so a finished tournament can be retired
 *   instead of alerting forever (BLAST).
 * - `FetchResult.suspectEmpty` folded into structured warnings — see src/core/warnings.ts.
 */

import type {
  GameSlug,
  SourceLeague,
  SourceMatch,
  SourceTournament,
} from './types.js';
import type { SourceWarning } from './warnings.js';

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/**
 * Declared rather than assumed.
 *
 * The sources differ in *capability*, not only in field names, so pretending uniformity pushes
 * the difference into runtime nulls. Declaring it lets the sync layer branch honestly.
 *
 * The rule for what belongs here: a fact the sync layer must branch on that is *not* already
 * expressed by the presence of a method. Anything expressible both ways is expressed once.
 */
export interface SourceCapabilities {
  /**
   * How `listScopes()` gets its answer.
   *
   * - `implicit` — one scope, intrinsic to the endpoint, no enumeration request. Riot: the
   *   schedule endpoint takes no scope parameter and returns everything.
   * - `api`      — enumerated from upstream. Stays current on its own.
   * - `manual`   — a hand-maintained list. BLAST has no tournament-listing endpoint and its
   *   listing page is server-rendered, so its slugs are typed by a human. This value exists so
   *   the sync layer can treat that list as a thing that rots.
   */
  scopeDiscovery: 'implicit' | 'api' | 'manual';

  /**
   * The state this adapter reports was **read**, not derived. BLAST's /matches has no state field
   * at all, so anything it reports must be inferred or joined from /brackets.
   *
   * Note that this is not "the source has a state field". Riot REST has one and `riot-rest-lol`
   * still declares `false`, because the field is wrong for matches with an undecided opponent and
   * the adapter overrides it from `result`. The flag describes the provenance of the value the sync
   * layer receives; a field that exists but is corrected is an inference, and saying otherwise
   * would invite the sync layer to trust it. The per-fetch `lossy-state` warning counts how many
   * rows needed correcting, which is a different question from this one.
   */
  explicitState: boolean;

  /**
   * Supplies stable team identifiers. Riot REST `getSchedule`: false — teams carry only `name`
   * and `code`, both unstable. A source with `false` here cannot feed the team crosswalk, and so
   * cannot back team subscriptions (FR-1), no matter how complete its match rows look.
   */
  teamIdentity: boolean;

  /**
   * Supplies per-match stream URLs. BLAST: true. Riot: false, and this is a settled answer, not
   * a pending probe — LoL and VALORANT fall back to a hand-maintained League.defaultStreamUrl.
   */
  streamUrls: boolean;

  /** Supports narrowing by date range. Riot: true (cursors). BLAST: false (whole tournament). */
  timeWindow: boolean;

  // historicalBackfill — deferred to Stage 1. Riot REST's cursors work; GraphQL's were null.
}

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

/**
 * A unit of fetching.
 *
 * This exists because BLAST has no global schedule endpoint — matches are only reachable as
 * `/tournaments/{slug}/matches`, so a slug must be known before anything can be fetched. Riot
 * needs no such thing. Rather than special-casing BLAST, the interface is shaped to the weaker
 * capability: enumerate scopes, then fetch per scope.
 */
export interface Scope {
  /** Stable within a source. Riot: "global". BLAST: the tournament slug. */
  key: string;
  label: string;

  /**
   * Where this scope came from. Matches the source's `scopeDiscovery`, but per scope, because a
   * source may eventually mix the two (an API list plus manual additions).
   */
  discovery: 'implicit' | 'api' | 'manual';

  /**
   * Validity window. Null means open-ended.
   *
   * A tournament that has ended returns an empty array forever. Without this, either the canary
   * screams every hour or it is disabled and the next real outage goes unnoticed. With it, a
   * scope past `activeUntil` is retired rather than alerted on.
   */
  activeFrom: string | null;
  activeUntil: string | null;
}

export interface TimeWindow {
  fromUtc: string;
  toUtc: string;
}

// ---------------------------------------------------------------------------
// Canaries
// ---------------------------------------------------------------------------

export interface CanaryResult {
  ok: boolean;
  detail: string;
}

/**
 * A semantic assertion about content, owned by the adapter that knows what "normal" looks like.
 *
 * The draft put this on Scope as `expectsMatches: boolean`. That does not fit: the spec's canary
 * is "LCK has at least one match in the next 14 days" — an assertion about *rows*, not about a
 * scope. Riot has exactly one global scope, so a scope-level flag can only say "some match, in
 * some league, somewhere" — which stays true while LCK silently vanishes.
 *
 * Scheduling these is Stage 1. Declaring and unit-testing them is Stage 0.
 */
export interface SourceCanary {
  key: string;
  /** Human-readable, and it is the alert text. "LCK has >= 1 match in the next 14 days." */
  description: string;
  /** Which scope's fetch this runs against. */
  scopeKey: string;
  check(matches: readonly SourceMatch[], now: Date): CanaryResult;
}

// ---------------------------------------------------------------------------
// Fetch results
// ---------------------------------------------------------------------------

export interface FetchDiagnostics {
  /**
   * How many upstream requests produced this result.
   *
   * The count surfaces; the orchestration does not. BLAST needs /matches plus /brackets to
   * produce one Match, and Riot REST needs getSchedule plus getLeagues — but the sync layer must
   * never learn that /brackets exists, or the adapter boundary has leaked (NFR-3). What it needs
   * is the cost, and a warning when a secondary request failed.
   */
  requestCount: number;
  bytes: number;
  [key: string]: unknown;
}

export interface FetchResult<T> {
  items: T[];
  /** Structured and aggregated by code. Emptiness is reported here, not as a bare array. */
  warnings: SourceWarning[];
  diagnostics: FetchDiagnostics;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export interface SourceAdapter {
  /** Stable identifier: "riot-rest-lol", "riot-gql-lol", "blast-cs". */
  readonly id: string;
  readonly game: GameSlug;
  readonly capabilities: SourceCapabilities;
  readonly canaries: readonly SourceCanary[];

  /**
   * Enumerate what can be fetched.
   *
   * Riot: one implicit global scope. BLAST: one per tournament, from a hand-maintained list
   * until slug discovery is solved (docs/sources/cs2-blast.md).
   */
  listScopes(): Promise<FetchResult<Scope>>;

  /** `window` is advisory: sources with `timeWindow: false` return everything in scope. */
  fetchMatches(scope: Scope, window?: TimeWindow): Promise<FetchResult<SourceMatch>>;

  /** Presence is the declaration. Absent when the source has no league tier (BLAST). */
  fetchLeagues?(): Promise<FetchResult<SourceLeague>>;

  fetchTournaments?(scope: Scope): Promise<FetchResult<SourceTournament>>;
}
