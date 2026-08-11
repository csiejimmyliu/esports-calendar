/**
 * Structured warnings from the adapter boundary.
 *
 * The draft interface had a single `suspectEmpty: boolean`. That is not enough vocabulary for
 * what the probed sources actually do: BLAST returns 200 + `[]` for a typo'd slug, Riot REST
 * reports unplayed TBD playoff matches as `completed`, and any source can be half-up (one of its
 * two endpoints answering). Each of those needs to be distinguishable upstream, and a free-text
 * string cannot be branched on or alerted from. So: codes, not prose.
 *
 * Warnings aggregate by code. A fixture with 80 http:// logo URLs must produce one warning with
 * count 80, not 80 warnings — otherwise the signal drowns in its own volume.
 */

export type WarningCode =
  /**
   * The source answered successfully and returned nothing, and the adapter believes that is
   * wrong. Confirmed in the wild: `GET /v2/games/cs/tournaments/NOT-A-REAL-SLUG/matches` is
   * HTTP 200 + `[]`, indistinguishable from a real tournament with nothing scheduled.
   */
  | 'suspect-empty'
  /**
   * An enum value we have never seen. Never throw, never drop silently — a fixture proves
   * existence, never absence. Riot's `type: "show"` was absent from all 80 LoL events sampled
   * and exists anyway.
   */
  | 'unknown-event-type'
  /**
   * A team-lifecycle value outside the set we know. Only `active` and `archived` appear across all
   * 1568 rows of the master table, which proves neither is the last one Riot will invent. An
   * unknown status fails the `active` test and simply keeps that team out of the table.
   */
  | 'unknown-team-status'
  /**
   * A state value outside the set we know how to map. Treated as `unstarted`, which is the
   * spoiler-safe direction (FR-3): guessing "upcoming" reveals nothing, guessing "completed"
   * would let a UI decide the match is worth a score.
   */
  | 'unknown-match-state'
  /** A match whose participant count is not two. Skipped, not crashed on. */
  | 'non-binary-sides'
  /**
   * State was derived with no upstream field to derive it from. Not emitted by any current adapter:
   * BLAST is the case it exists for, because /matches carries no state at all and the value has to
   * come from /brackets or from the clock. Distinct from `lossy-state`, which means a field existed
   * and was overridden — a reader of the two codes can tell "there was nothing to read" from "what
   * we read was wrong", and those warrant different upstream trust.
   *
   * Kept as a declared code with no emitter because the vocabulary belongs to the interface rather
   * than to whichever adapter happens to exist. Deleting it would mean re-deciding the distinction
   * later, under time pressure, in the middle of writing a second adapter.
   */
  | 'state-inferred'
  /**
   * The source reported a state we can prove is wrong, and the adapter overrode it. The count is
   * how many rows were **corrected**, not how many are broken.
   *
   * Riot REST reports unplayed matches with an undecided opponent as `completed` — three of them
   * in the captured sample, one scheduled for the following day. A separate field (`result`)
   * settles it exactly, so the adapter uses that and says so.
   */
  | 'lossy-state'
  /** The source cannot identify teams, so nothing here can feed the team crosswalk. */
  | 'no-team-identity'
  /**
   * A team resolved by its fallback key rather than its primary one: the two endpoints disagree on
   * the team's name, and only the code still matched.
   *
   * The identity is right — this is not an error. It is the early symptom of a rename that has
   * propagated to one endpoint and not the other, and the interesting thing about it is what happens
   * next: if the code changes too (rebrands usually change both), the next sync misses entirely. A
   * warning here is days of notice before a `team-unresolved`.
   */
  | 'team-name-mismatch'
  /**
   * A team appeared in a match we do classify, and neither its name nor its code matches any row in
   * the team table.
   * The match is kept and the name preserved — a calendar entry without a crosswalk id is still a
   * calendar entry, and dropping it would be a silent hole. Expected causes: a promoted team the
   * master table has not caught up with, a rename, or a tier list that has drifted.
   */
  | 'team-unresolved'
  /**
   * Two teams in the table claim one code and no manual override settles it. Resolving nothing is
   * the required outcome: picking either one attaches a real, wrong identity to a real match, and
   * every downstream subscription then silently follows the wrong team. Confirmed live: EG is
   * Evil Geniuses LG in LCS and Evil Geniuses EU in LEC, both first teams in major leagues.
   */
  | 'team-ambiguous'
  /**
   * A league slug that config/leagues.json does not mention at all. Not the same as an explicit
   * `minor`: this is a league that appeared upstream after the file was last reviewed, and three
   * did during 2026 alone. Its matches are treated as out of scope, loudly.
   */
  | 'unclassified-league'
  /** One item failed validation. The rest of the batch survives — partial failure isolation. */
  | 'unparsable-item'
  /** A secondary request failed; the result is present but less complete than usual. */
  | 'degraded-fetch'
  /**
   * A hand-maintained list may have gone stale. BLAST has no tournament-listing endpoint, so its
   * scopes are typed by a human — and a missing new tournament is invisible by construction.
   *
   * `riot-rest-lol` emits it for the analogous case on its own hand-maintained list: a slug
   * config/leagues.json covers that getLeagues no longer returns. Its teams then cannot enter the
   * team table, and shipping a quietly smaller table is exactly the silent narrowing this code
   * exists to prevent.
   */
  | 'scope-list-stale';

export interface SourceWarning {
  code: WarningCode;
  message: string;
  /** How many times this fired in one fetch. */
  count: number;
  /** One representative offender, for the log line. Never the whole batch. */
  sample?: unknown;
}

/**
 * Accumulates warnings by code so callers can `warn()` freely in a loop.
 */
export class WarningCollector {
  readonly #byCode = new Map<WarningCode, SourceWarning>();

  warn(code: WarningCode, message: string, sample?: unknown): void {
    const existing = this.#byCode.get(code);
    if (existing) {
      existing.count += 1;
      return;
    }
    this.#byCode.set(
      code,
      sample === undefined ? { code, message, count: 1 } : { code, message, count: 1, sample },
    );
  }

  /** Merge warnings produced elsewhere (e.g. a nested fetch) into this collector. */
  absorb(warnings: readonly SourceWarning[]): void {
    for (const w of warnings) {
      const existing = this.#byCode.get(w.code);
      if (existing) {
        existing.count += w.count;
      } else {
        this.#byCode.set(w.code, { ...w });
      }
    }
  }

  has(code: WarningCode): boolean {
    return this.#byCode.has(code);
  }

  list(): SourceWarning[] {
    return [...this.#byCode.values()];
  }
}

export function formatWarning(w: SourceWarning): string {
  const times = w.count > 1 ? ` (x${String(w.count)})` : '';
  return `[${w.code}]${times} ${w.message}`;
}
