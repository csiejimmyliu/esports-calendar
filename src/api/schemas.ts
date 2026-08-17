/**
 * Request validation. Everything a caller sends passes through here before it reaches a query
 * module — `zod` was already a dependency (it validates every upstream response at the adapter
 * boundary), so the same discipline applies in the other direction at no cost.
 */

import { z } from 'zod';

import { parseUtcInstant } from '../core/time.js';
import type { OverviewCursor } from '../db/queries/overview.js';
import { ApiError, formatZodError } from './errors.js';

/**
 * Runs a schema and converts a failure into the API's own 400, never a 500.
 *
 * Generic over the schema rather than over a result type, so `z.output` applies: a field with a
 * `.default()` is optional on the way in and present on the way out, and typing this as
 * `z.ZodType<T>` would hand callers the input type with every default still `| undefined`.
 */
export function parseOrThrow<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw ApiError.badRequest(formatZodError(result.error));
  return result.data;
}

/**
 * An instant with an explicit zone marker, reusing `parseUtcInstant` rather than `z.string().datetime()`.
 *
 * The repo's rule is that a timestamp without a zone is refused, never guessed at (NFR-7,
 * src/core/time.ts) — and that rule has to hold for what a client sends just as much as for what
 * Riot sends, or the API becomes the one place a naive timestamp gets silently interpreted in the
 * server's local zone.
 */
const instant = z.string().superRefine((raw, ctx) => {
  try {
    parseUtcInstant(raw, 'anchor');
  } catch (err) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: err instanceof Error ? err.message : 'not a valid instant',
    });
  }
});

/**
 * The paging limit is capped rather than merely defaulted. Without a ceiling a client can ask for
 * the entire match table in one request, which is a denial-of-service against our own database
 * with no attacker required — a paging bug in a client is enough.
 */
const MAX_LIMIT = 100;

/** Repeated query parameters arrive as `string` for one and `string[]` for many. Normalise both. */
const stringList = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v]));

export const pageQuerySchema = z.object({
  /**
   * Required, never defaulted to the system clock.
   *
   * `src/cli/next-matches.ts` warns and prints nothing when `--now` is omitted, for the same
   * reason: an endpoint that silently substitutes wall-clock time answers a different question
   * than the one asked, and against a frozen fixture it answers nothing at all. Making the client
   * state its own reference point keeps the server stateless in the sense NFR-6 means.
   */
  anchor: instant,
  direction: z.enum(['forward', 'backward']).default('forward'),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(50),
  cursor: z.string().optional(),
  league: stringList,
  team: stringList,
});

export type PageQuery = z.output<typeof pageQuerySchema>;

export const followBodySchema = z.object({
  targetType: z.enum(['league', 'team']),
  targetId: z.string().min(1),
});

export const followParamsSchema = z.object({
  targetType: z.enum(['league', 'team']),
  targetId: z.string().min(1),
});

export const selectionBodySchema = z.object({
  state: z.enum(['included', 'excluded']),
});

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

/**
 * The keyset cursor is opaque over the wire.
 *
 * `src/db/queries/overview.ts` pages on `(starts_at_utc, id)`; encoding that as one base64url
 * string means a client echoes what it was handed instead of reconstructing a tuple, and the
 * internal ordering key can change later without a client change. It is encoding, not encryption
 * — a caller who decodes it learns a timestamp and a match id, both of which are in the response
 * anyway.
 */
const cursorSchema = z.object({ startsAtUtc: z.string(), id: z.string() });

export function encodeCursor(cursor: OverviewCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): OverviewCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    // A garbage cursor is the caller's mistake, not a server fault. Without this it would surface
    // as a 500 from JSON.parse.
    throw ApiError.badRequest('cursor is not a valid pagination cursor');
  }
  return parseOrThrow(cursorSchema, parsed);
}
