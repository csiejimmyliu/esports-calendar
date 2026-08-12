/**
 * Unit tests for src/fixtures/shape.ts on synthetic before/after pairs — independent of any real
 * fixture, so these pin down the five drift signals `capture:check` reports on:
 *   1. a new key appears
 *   2. a key disappears
 *   3. a field that was never null starts being null
 *   4. an enum-like field produces a value never seen before
 *   5. a collection's row count drops to zero
 */

import { describe, expect, it } from 'vitest';

import { diffShape, isShapeDiffEmpty, summarizeShape } from '../src/fixtures/shape.js';

describe('summarizeShape / diffShape', () => {
  it('reports no diff for two structurally identical documents with different content', () => {
    // Same keys, same types, same `state` values, same non-zero row count — only the id and the
    // row count within it differ, neither of which this module reports on. `id` fields are
    // intentionally NOT compared by value: with enough rows they exceed the enum cardinality limit
    // and get dropped, same as team names or match ids would in a real fixture (see the
    // high-cardinality test below) — this test keeps it small on purpose to show that even a
    // *small* set of ids produces no false positive as long as none of them repeat as a "new"
    // value relative to `before` (both documents reuse the same id, '1').
    const before = { data: { events: [{ id: '1', state: 'unstarted' }, { id: '1', state: 'completed' }] } };
    const after = { data: { events: [{ id: '1', state: 'completed' }] } };
    const diff = diffShape(summarizeShape(before), summarizeShape(after));
    expect(isShapeDiffEmpty(diff)).toBe(true);
  });

  it('catches a new key appearing on an array element', () => {
    const before = { data: { teams: [{ id: '1', name: 'A' }] } };
    const after = { data: { teams: [{ id: '1', name: 'A', code: 'A1' }] } };
    const diff = diffShape(summarizeShape(before), summarizeShape(after));
    expect(diff.keysAdded['data.teams[]']).toEqual(['code']);
    expect(isShapeDiffEmpty(diff)).toBe(false);
  });

  it('catches a key disappearing — the dangerous direction, since a reader just sees undefined', () => {
    const before = { data: { teams: [{ id: '1', code: 'A1' }] } };
    const after = { data: { teams: [{ id: '1' }] } };
    const diff = diffShape(summarizeShape(before), summarizeShape(after));
    expect(diff.keysRemoved['data.teams[]']).toEqual(['code']);
  });

  it('catches a field that was never null starting to be null', () => {
    const before = { data: { events: [{ result: { outcome: 'win' } }] } };
    const after = { data: { events: [{ result: { outcome: null } }] } };
    const diff = diffShape(summarizeShape(before), summarizeShape(after));
    expect(diff.typesAdded['data.events[].result.outcome']).toEqual(['null']);
  });

  it('catches a new value on a low-cardinality enum-like field', () => {
    const before = {
      data: {
        events: [{ type: 'match' }, { type: 'match' }],
      },
    };
    const after = {
      data: {
        events: [{ type: 'match' }, { type: 'show' }],
      },
    };
    const diff = diffShape(summarizeShape(before), summarizeShape(after));
    expect(diff.newEnumValues['data.events[].type']).toEqual(['show']);
  });

  it('catches a collection dropping to zero rows — the silent-empty-parse failure mode', () => {
    const before = { data: { schedule: { events: [{ id: '1' }, { id: '2' }] } } };
    const after = { data: { schedule: { events: [] as unknown[] } } };
    const diff = diffShape(summarizeShape(before), summarizeShape(after));
    expect(diff.arraysNowEmpty).toContain('data.schedule.events');
  });

  it('does not flag a collection that was already empty and stays empty', () => {
    const before = { data: { schedule: { events: [] as unknown[] } } };
    const after = { data: { schedule: { events: [] as unknown[] } } };
    const diff = diffShape(summarizeShape(before), summarizeShape(after));
    expect(diff.arraysNowEmpty).toHaveLength(0);
  });

  it('drops a high-cardinality string field from enum tracking rather than reporting every value as new', () => {
    const manyDistinctNames = Array.from({ length: 30 }, (_, i) => ({ name: `Team ${String(i)}` }));
    const before = { data: { teams: manyDistinctNames.slice(0, 25) } };
    const after = { data: { teams: manyDistinctNames } };
    const diff = diffShape(summarizeShape(before), summarizeShape(after));
    // `name` exceeded the cardinality limit in `before` already, so it was dropped from
    // enumValuesByPath entirely — new names appearing must not show up as "new enum values".
    expect(diff.newEnumValues['data.teams[].name']).toBeUndefined();
  });
});
