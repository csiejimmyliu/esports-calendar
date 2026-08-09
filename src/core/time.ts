/**
 * Time handling.
 *
 * Two rules, both from NFR-7 and from what the sources actually emit:
 *
 * 1. UTC in storage; conversion happens only at the render boundary.
 * 2. Parse per field, never with one shared lenient parser. BLAST puts `Z` on `scheduledAt` and
 *    omits it on `tournament.startDate` *in the same object*. `new Date("2026-07-21T12:00:00")`
 *    silently interprets that in the host's local zone, which is correct on a laptop in UTC and
 *    seven hours wrong in Taipei. That class of bug does not announce itself.
 */

/** Injected everywhere, so no fixture-backed code path can read the wall clock. */
export interface Clock {
  now(): Date;
}

export function fixedClock(iso: string): Clock {
  const at = parseUtcInstant(iso, 'fixedClock');
  return { now: () => new Date(at) };
}

export const systemClock: Clock = { now: () => new Date() };

export class TimestampError extends Error {
  constructor(
    readonly field: string,
    readonly raw: string,
    reason: string,
  ) {
    super(`${field}: ${reason} (got ${JSON.stringify(raw)})`);
    this.name = 'TimestampError';
  }
}

const ZONED = /(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * Parse a timestamp that must carry an explicit zone. Returns epoch milliseconds.
 *
 * Rejects rather than guesses. A source that starts omitting its zone marker is a source whose
 * times we no longer know, and the loud version of that is a parse failure on one field, not a
 * calendar that is quietly off by hours.
 */
export function parseUtcInstant(raw: string, field: string): number {
  if (!ZONED.test(raw)) {
    throw new TimestampError(field, raw, 'timestamp has no timezone marker, refusing to guess');
  }
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    throw new TimestampError(field, raw, 'not a parsable ISO 8601 timestamp');
  }
  return ms;
}

/** Canonical storage form: ISO 8601, always UTC, always `Z`, no sub-second noise. */
export function toUtcIso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function normalizeToUtcIso(raw: string, field: string): string {
  return toUtcIso(parseUtcInstant(raw, field));
}

const PARTS = [
  'year',
  'month',
  'day',
  'hour',
  'minute',
  'weekday',
] as const;
type PartName = (typeof PARTS)[number];

/**
 * Render a UTC instant in a target zone. Intl carries the tz database, so no dependency and no
 * hand-maintained offset table — and DST is handled by definition rather than by remembering to.
 */
export function formatInZone(
  utcIso: string,
  timeZone: string,
  locale = 'en-GB',
): { date: string; time: string; weekday: string } {
  const at = new Date(parseUtcInstant(utcIso, 'formatInZone'));
  const parts = new Intl.DateTimeFormat(locale, {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  }).formatToParts(at);

  const found = {} as Record<PartName, string>;
  for (const p of parts) {
    if ((PARTS as readonly string[]).includes(p.type)) {
      found[p.type as PartName] = p.value;
    }
  }

  return {
    date: `${found.year}-${found.month}-${found.day}`,
    time: `${found.hour}:${found.minute}`,
    weekday: found.weekday,
  };
}

export function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 86_400_000);
}
