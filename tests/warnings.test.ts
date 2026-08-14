/**
 * `WarningCollector` and `formatWarning` (src/core/warnings.ts).
 *
 * The class doc comment states: "Accumulates warnings by code so callers can `warn()` freely in
 * a loop." The file header adds the reason: "A fixture with 80 http:// logo URLs must produce
 * one warning with count 80, not 80 warnings — otherwise the signal drowns in its own volume."
 * That means `#byCode` is a real accumulator keyed by code, not a log of calls, and the tests
 * below exercise that accumulation directly (repeated `warn()` on one code, `warn()` across two
 * codes, `absorb()` into an empty vs. an already-populated code) rather than restating a single
 * call's inputs.
 *
 * `warn()`'s behaviour on a repeat call for the same code (keep the first message/sample, only
 * bump `count`) and `absorb()`'s behaviour on a code already present (sum counts, keep the
 * collector's own message/sample, not the absorbed one) were named directly in this run's task
 * as the properties to pin; that is a caller-stated guarantee (see house style, source #5). Both
 * are also consistent with the `sample` field's doc comment: "One representative offender, for
 * the log line. Never the whole batch" — a merge that adopted every absorbed sample would violate
 * "never the whole batch".
 */
import { describe, expect, it } from 'vitest';

import { formatWarning, WarningCollector } from '../src/core/warnings.js';
import type { SourceWarning } from '../src/core/warnings.js';

describe('WarningCollector', () => {
  it('records a single warn() call as one entry with count 1 and the given message/sample', () => {
    const collector = new WarningCollector();
    collector.warn('suspect-empty', 'endpoint returned zero rows', { slug: 'not-a-real-slug' });

    expect(collector.list()).toEqual([
      {
        code: 'suspect-empty',
        message: 'endpoint returned zero rows',
        count: 1,
        sample: { slug: 'not-a-real-slug' },
      },
    ]);
  });

  it('accumulates two different codes independently rather than lumping them into one bucket', () => {
    const collector = new WarningCollector();
    collector.warn('suspect-empty', 'zero rows', 'a');
    collector.warn('unclassified-league', 'unknown slug', 'b');

    // Precondition: has() distinguishes a code that was warned from one that never was. If warn()
    // or has() collapsed everything to a single key, this would be true for a third, unrelated
    // code too.
    expect(collector.has('team-unresolved')).toBe(false);
    expect(collector.has('suspect-empty')).toBe(true);
    expect(collector.has('unclassified-league')).toBe(true);

    const byCode = new Map(collector.list().map((w) => [w.code, w]));
    expect(byCode.get('suspect-empty')).toEqual({
      code: 'suspect-empty',
      message: 'zero rows',
      count: 1,
      sample: 'a',
    });
    expect(byCode.get('unclassified-league')).toEqual({
      code: 'unclassified-league',
      message: 'unknown slug',
      count: 1,
      sample: 'b',
    });
  });

  it('keeps only the first call\'s message and sample across repeat warn()s on the same code, incrementing count each time', () => {
    const collector = new WarningCollector();
    collector.warn('unclassified-league', 'first message', 'first-sample');
    collector.warn('unclassified-league', 'second message', 'second-sample');
    collector.warn('unclassified-league', 'third message', 'third-sample');

    // Vacuity guard: each call uses a distinct message/sample. If the collector overwrote on
    // repeat calls (kept the *last* one) instead of accumulating, this would report
    // 'third message'/'third-sample' instead of the first call's values, and if it didn't
    // increment at all, count would read 1 instead of 3.
    expect(collector.list()).toEqual([
      {
        code: 'unclassified-league',
        message: 'first message',
        count: 3,
        sample: 'first-sample',
      },
    ]);
  });

  it('absorb() copies in a code the collector has not seen yet, unchanged', () => {
    const collector = new WarningCollector();
    const incoming: SourceWarning[] = [
      { code: 'crawl-incomplete', message: 'stopped at horizon', count: 4, sample: { horizonUtc: '2026-08-20T00:00:00Z' } },
    ];

    // Setup, not a guard: this just confirms the collector starts empty. The real check is the
    // toEqual() below, which would already fail loudly if absorb() were a no-op.
    expect(collector.has('crawl-incomplete')).toBe(false);

    collector.absorb(incoming);

    expect(collector.list()).toEqual([
      {
        code: 'crawl-incomplete',
        message: 'stopped at horizon',
        count: 4,
        sample: { horizonUtc: '2026-08-20T00:00:00Z' },
      },
    ]);
  });

  it('absorb() sums counts into a code already present, keeping the collector\'s own message and sample', () => {
    const collector = new WarningCollector();
    collector.warn('degraded-fetch', 'own message', 'own-sample');

    const incoming: SourceWarning[] = [
      { code: 'degraded-fetch', message: 'absorbed message', count: 5, sample: 'absorbed-sample' },
    ];
    collector.absorb(incoming);

    // Vacuity guard: the pre-existing entry and the absorbed one use deliberately different
    // message/sample/count values. If absorb() overwrote message/sample from the incoming
    // warning instead of only summing count, or replaced the entry outright, the assertion below
    // would show 'absorbed message'/'absorbed-sample'/count 5 instead.
    expect(collector.list()).toEqual([
      {
        code: 'degraded-fetch',
        message: 'own message',
        count: 6,
        sample: 'own-sample',
      },
    ]);
  });
});

describe('formatWarning', () => {
  it('renders code and message with no repetition marker when count is 1', () => {
    const warning: SourceWarning = { code: 'no-team-identity', message: 'source has no team ids', count: 1 };
    expect(formatWarning(warning)).toBe('[no-team-identity] source has no team ids');
  });

  it('surfaces the aggregate count in the rendered line when a warning fired more than once', () => {
    // Inference, not a direct quotation: the file header states the aggregation guarantee ("A
    // fixture with 80 http:// logo URLs must produce one warning with count 80, not 80
    // warnings"), but says nothing about rendering. The step that the guarantee is only
    // meaningful if the rendered line exposes the count somewhere is this test's own reasoning.
    const warning: SourceWarning = { code: 'lossy-state', message: 'result disagreed with state', count: 80 };
    const rendered = formatWarning(warning);
    expect(rendered).toContain('[lossy-state]');
    expect(rendered).toContain('result disagreed with state');
    expect(rendered).toContain('80');
  });
});
