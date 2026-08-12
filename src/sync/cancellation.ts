/**
 * Which previously-ingested matches a fetch's absence should be read as "cancelled".
 *
 * Pure, DB-free, table-tested. A match vanishing from the feed is how a cancellation actually
 * arrives (src/core/types.ts's MatchState comment) — riot-rest-lol has no state value that means
 * it. But Stage 0.7's crawl can stop early (`crawl-incomplete`), and a crawl that did not reach
 * the end says nothing about matches past the point it reached: absence there is missing data,
 * not evidence of cancellation.
 *
 * Two guards, both required:
 *   1. `horizon.complete` — a partial crawl detects zero cancellations, ever.
 *   2. the match's own `startsAtUtc` falls inside `[horizon.fromUtc, horizon.toUtc]` — the actual
 *      range this run's pages covered. A match from last month that a ~3-day forward crawl simply
 *      never asked about is not "absent from the feed"; it is out of range.
 */

export interface KnownMatch {
  externalId: string;
  startsAtUtc: string;
}

export interface FetchHorizon {
  /** Earliest startsAtUtc among the matches this run actually fetched. */
  fromUtc: string;
  /** Latest startsAtUtc among the matches this run actually fetched. */
  toUtc: string;
  /** From FetchDiagnostics.crawlComplete / the crawl-incomplete warning's absence. */
  complete: boolean;
}

/**
 * Returns the externalIds of `previouslyKnown` matches that should now be marked cancelled.
 *
 * `fetchedExternalIds` empty is treated the same as an incomplete horizon: nothing was fetched at
 * all is closer to "the source is down" than to "every match in range was cancelled", and
 * suspect-empty already covers that failure mode upstream — this function just declines to act on it.
 */
export function detectCancellations(
  previouslyKnown: readonly KnownMatch[],
  fetchedExternalIds: ReadonlySet<string>,
  horizon: FetchHorizon,
): string[] {
  if (!horizon.complete || fetchedExternalIds.size === 0) return [];
  return previouslyKnown
    .filter((m) => m.startsAtUtc >= horizon.fromUtc && m.startsAtUtc <= horizon.toUtc)
    .filter((m) => !fetchedExternalIds.has(m.externalId))
    .map((m) => m.externalId);
}
