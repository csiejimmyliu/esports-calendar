import { describe, expect, it } from 'vitest';

import { detectCancellations } from '../src/sync/cancellation.js';
import type { KnownMatch } from '../src/sync/cancellation.js';

const HORIZON = { fromUtc: '2026-08-09T00:00:00Z', toUtc: '2026-08-16T00:00:00Z' };
const KNOWN: KnownMatch[] = [
  { externalId: 'm1', startsAtUtc: '2026-08-10T08:00:00Z' }, // inside horizon
  { externalId: 'm2', startsAtUtc: '2026-08-01T08:00:00Z' }, // before horizon
  { externalId: 'm3', startsAtUtc: '2026-08-20T08:00:00Z' }, // after horizon
];

describe('detectCancellations', () => {
  it('flags a known match inside the horizon that the fetch no longer contains', () => {
    const fetched = new Set(['other-match']);
    expect(detectCancellations(KNOWN, fetched, { ...HORIZON, complete: true })).toEqual(['m1']);
  });

  it('never flags a match outside the range this crawl actually covered', () => {
    // m2 and m3 are absent from `fetched` too, but a ~3-day forward crawl never asked about
    // them at all — their absence carries no information, per src/sync/cancellation.ts's header.
    // Only m1, which is inside the horizon, is eligible to be flagged.
    const fetched = new Set(['other-match']);
    const flagged = detectCancellations(KNOWN, fetched, { ...HORIZON, complete: true });
    expect(flagged).toEqual(['m1']);
    expect(flagged).not.toContain('m2');
    expect(flagged).not.toContain('m3');
  });

  it('does not flag a match still present in the fetch', () => {
    const fetched = new Set(['m1']);
    expect(detectCancellations(KNOWN, fetched, { ...HORIZON, complete: true })).toEqual([]);
  });

  it('flags nothing when the crawl was incomplete — the guard this function exists for', () => {
    // A transient page-2 failure must not cancel the rest of the season. Same KNOWN/fetched as
    // the first case, differing only in `complete`.
    const fetched = new Set(['other-match']);
    expect(detectCancellations(KNOWN, fetched, { ...HORIZON, complete: false })).toEqual([]);
  });

  it('flags nothing when the fetch itself came back empty', () => {
    // An empty fetch is closer to "source is down" than "everything in range was cancelled";
    // suspect-empty already covers that failure mode upstream.
    expect(detectCancellations(KNOWN, new Set(), { ...HORIZON, complete: true })).toEqual([]);
  });
});
