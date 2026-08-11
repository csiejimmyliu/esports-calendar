/**
 * The sidecar schema, and the transform executor that makes a `recapture` block re-derivable
 * rather than descriptive.
 *
 * Three sessions have each written a `<fixture>.meta.json` in a different shape: the original 13
 * committed sidecars use `fixture/source/request/capturedOn/contents/verification` plus ad hoc
 * extra keys per file; `scripts/capture-fixture.ts` (before this change) wrote
 * `endpoint/url/queryParams/capturedAt/bytes/rowCounts`; an earlier agent task that produced
 * `rest_getSchedule_ewc.json` was briefed to write `endpoint/method/headers/capturedOn/hl/
 * cursorUsed/originalMatchCount/trimmedMatchCount/trimming`. None of the three was ever validated
 * against the others.
 *
 * This module does not try to force every existing sidecar into one rigid shape — the free-form
 * prose fields (`verification`, `whyThisFixtureExists`, `knownDiscrepancy`, …) earn their keep and
 * differ fixture to fixture for good reason. What it standardizes is the one part that has to be
 * machine-readable to be useful at all: `recapture`, which says whether a fixture can be
 * re-derived from a fresh capture, and if so, exactly how (endpoint, params, and the trim/redact
 * steps as executable operations instead of a paragraph of English).
 */

import { z } from 'zod';

const StripFieldOp = z.object({
  op: z.literal('stripField'),
  /** `data.teams[].players` — the `[]` marks the array being iterated; the segment after the
   *  final `.` is the field removed from every element. */
  path: z.string().min(1),
  why: z.string().min(1),
});

const SelectByKeyOp = z.object({
  op: z.literal('selectByKey'),
  /** Path to the array itself, no trailing `[]` — e.g. `data.teams`. */
  path: z.string().min(1),
  /** Field on each element compared against `keep`. Dot-separated to reach a nested field, e.g.
   *  `match.id` for a schedule event. */
  key: z.string().min(1),
  keep: z.array(z.string()).min(1),
  /** Optional field to sort the retained elements by, so a re-trim of an unchanged upstream
   *  response is byte-identical regardless of the order the live API happened to return. */
  sort: z.string().optional(),
  why: z.string().min(1),
});

export const TransformOp = z.discriminatedUnion('op', [StripFieldOp, SelectByKeyOp]);
export type TransformOp = z.infer<typeof TransformOp>;

const RecaptureBlock = z.discriminatedUnion('capturable', [
  z.object({
    capturable: z.literal(true),
    endpoint: z.string().min(1),
    params: z.record(z.string(), z.string()),
    transform: z.array(TransformOp),
  }),
  z.object({
    capturable: z.literal(false),
    reason: z.string().min(1),
  }),
]);
export type RecaptureBlock = z.infer<typeof RecaptureBlock>;

/**
 * The common core every committed sidecar has, plus the new machine-readable `recapture` block.
 * Everything else (`verification`, `trimming`, `measurements`, and fixture-specific keys like
 * `whyThisFixtureExists` or `knownDiscrepancy`) is passed through unvalidated — those are prose
 * fields, and forcing them into a rigid schema would be exactly the mistake this module exists to
 * avoid repeating a fourth time.
 */
export const FixtureSidecar = z
  .object({
    fixture: z.string().min(1),
    source: z.string().min(1),
    request: z.object({
      method: z.string().min(1),
      url: z.string().min(1),
      queryParams: z.record(z.string(), z.string()).optional(),
      pathParams: z.record(z.string(), z.string()).optional(),
      headers: z.record(z.string(), z.string()).optional(),
    }),
    capturedOn: z.string().min(1),
    contents: z.string().min(1),
    recapture: RecaptureBlock,
  })
  .passthrough();
export type FixtureSidecar = z.infer<typeof FixtureSidecar>;

/** Navigate dot-separated segments (no `[]`) to the value at that path. */
function getByPath(obj: unknown, segments: string[]): unknown {
  let cur = obj;
  for (const seg of segments) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function setByPath(root: unknown, segments: string[], value: unknown): void {
  let cur = root as Record<string, unknown>;
  for (let i = 0; i < segments.length - 1; i++) {
    cur = cur[segments[i] as string] as Record<string, unknown>;
  }
  cur[segments[segments.length - 1] as string] = value;
}

/**
 * Apply a fixture's recorded `transform` ops to a freshly captured (or full, uncommitted) document
 * and return the result a fresh clone of `input`, so the caller's object is never mutated.
 *
 * This is the function tests/fixture-transform.test.ts calls to prove that `rest_getTeams.json`'s
 * `recapture.transform` genuinely reproduces the committed 71 rows from the full 1568-row capture —
 * i.e. that the sidecar's transform is executable truth, not a description nobody has run.
 */
export function applyTransform(input: unknown, ops: TransformOp[]): unknown {
  const doc: unknown = JSON.parse(JSON.stringify(input));

  for (const op of ops) {
    if (op.op === 'stripField') {
      const match = /^(.*)\[\]\.([^.]+)$/.exec(op.path);
      if (!match) {
        throw new Error(`stripField path must look like 'a.b[].field', got: ${op.path}`);
      }
      const arrayPath = match[1] as string;
      const field = match[2] as string;
      const arr = getByPath(doc, arrayPath.split('.'));
      if (!Array.isArray(arr)) throw new Error(`stripField: ${arrayPath} did not resolve to an array`);
      for (const item of arr as Record<string, unknown>[]) delete item[field];
    } else {
      const segments = op.path.split('.');
      const arr = getByPath(doc, segments);
      if (!Array.isArray(arr)) throw new Error(`selectByKey: ${op.path} did not resolve to an array`);
      const keySegments = op.key.split('.');
      const keepSet = new Set(op.keep);
      let filtered = (arr as Record<string, unknown>[]).filter((item) =>
        keepSet.has(String(getByPath(item, keySegments))),
      );
      if (op.sort !== undefined) {
        const sortSegments = op.sort.split('.');
        filtered = [...filtered].sort((a, b) => {
          const av = String(getByPath(a, sortSegments));
          const bv = String(getByPath(b, sortSegments));
          return av < bv ? -1 : av > bv ? 1 : 0;
        });
      }
      setByPath(doc, segments, filtered);
    }
  }

  return doc;
}
