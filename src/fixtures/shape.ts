/**
 * "Shape" comparison for a captured JSON document — what changed in the STRUCTURE of an upstream
 * response, not in its content.
 *
 * A byte diff between a fresh capture and a committed fixture is useless: every match's time,
 * score, and id differ on every request, so the diff is 100% red and carries zero information.
 * What actually matters for "did Riot change something we depend on" is narrower: did a key
 * appear or disappear, did a field that was never null start being null, did an enum field
 * (`type`, `state`, `outcome`, …) produce a value we have never seen, did the top-level collection
 * drop to zero rows.
 *
 * This module is pure — no filesystem, no network — so it is unit-testable on synthetic
 * before/after pairs (see tests/fixture-shape.test.ts) independent of any real fixture.
 */

/** Array indices are folded into a single `[]` segment so shape is independent of row count. */
export type ShapePath = string;

export interface ShapeSummary {
  /** For every path reached, the set of keys ever seen on the object at that path. */
  keysByPath: Record<ShapePath, string[]>;
  /** For every leaf path, the set of JS types ever seen there ('null' included as a type). */
  typesByPath: Record<ShapePath, string[]>;
  /**
   * For every leaf path with a small number of distinct string values (<= ENUM_CARDINALITY_LIMIT),
   * the values seen. This is how a new `type` or `state` value gets caught. A path that exceeds the
   * limit (team names, ids, …) is dropped rather than truncated — a partial enum is worse than none,
   * because it would report every legitimate high-cardinality value as "new".
   */
  enumValuesByPath: Record<ShapePath, string[]>;
  /** Row count of every array found, keyed by its path. */
  arrayLengthByPath: Record<ShapePath, number>;
}

const ENUM_CARDINALITY_LIMIT = 20;

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** Walk a parsed JSON document and record every key, type, low-cardinality value, and array length. */
export function summarizeShape(doc: unknown): ShapeSummary {
  const keysByPath: Record<ShapePath, Set<string>> = {};
  const typesByPath: Record<ShapePath, Set<string>> = {};
  const enumCandidates: Record<ShapePath, Set<string>> = {};
  const arrayLengthByPath: Record<ShapePath, number> = {};

  function visit(value: unknown, path: ShapePath): void {
    const t = typeOf(value);
    (typesByPath[path] ??= new Set()).add(t);

    if (t === 'array') {
      const arr = value as unknown[];
      arrayLengthByPath[path] = (arrayLengthByPath[path] ?? 0) + arr.length;
      const childPath = `${path}[]`;
      for (const item of arr) visit(item, childPath);
      return;
    }

    if (t === 'object') {
      const obj = value as Record<string, unknown>;
      const keys = (keysByPath[path] ??= new Set());
      for (const key of Object.keys(obj)) {
        keys.add(key);
        visit(obj[key], path === '' ? key : `${path}.${key}`);
      }
      return;
    }

    if (t === 'string') {
      const set = (enumCandidates[path] ??= new Set());
      if (set.size <= ENUM_CARDINALITY_LIMIT) set.add(value as string);
    }
  }

  visit(doc, '');

  const enumValuesByPath: Record<ShapePath, string[]> = {};
  for (const [path, values] of Object.entries(enumCandidates)) {
    if (values.size <= ENUM_CARDINALITY_LIMIT) enumValuesByPath[path] = [...values].sort();
  }

  return {
    keysByPath: Object.fromEntries(Object.entries(keysByPath).map(([p, s]) => [p, [...s].sort()])),
    typesByPath: Object.fromEntries(Object.entries(typesByPath).map(([p, s]) => [p, [...s].sort()])),
    enumValuesByPath,
    arrayLengthByPath,
  };
}

export interface ShapeDiff {
  /** Paths whose key set gained members going from `before` to `after`. */
  keysAdded: Record<ShapePath, string[]>;
  /** Paths whose key set lost members. This is the dangerous direction: a parser reading a key
   *  that has vanished silently gets `undefined` instead of an error. */
  keysRemoved: Record<ShapePath, string[]>;
  /** Paths that started producing a type they never had before — `null` appearing is the common case. */
  typesAdded: Record<ShapePath, string[]>;
  /** Enum-like leaf paths that produced a value never seen in `before`. */
  newEnumValues: Record<ShapePath, string[]>;
  /** Arrays whose row count dropped to exactly zero going from `before` to `after`. The failure
   *  mode CLAUDE.md calls out by name: HTTP 200, valid JSON, zero rows. */
  arraysNowEmpty: ShapePath[];
}

function diffKeyedStringArrays(
  before: Record<ShapePath, string[]>,
  after: Record<ShapePath, string[]>,
): Record<ShapePath, string[]> {
  const out: Record<ShapePath, string[]> = {};
  for (const [path, afterValues] of Object.entries(after)) {
    const beforeSet = new Set(before[path] ?? []);
    const added = afterValues.filter((v) => !beforeSet.has(v));
    if (added.length > 0) out[path] = added;
  }
  return out;
}

/** Compare two shape summaries. Order matters: `before` is the committed fixture, `after` is live. */
export function diffShape(before: ShapeSummary, after: ShapeSummary): ShapeDiff {
  const keysAdded = diffKeyedStringArrays(before.keysByPath, after.keysByPath);
  const keysRemoved = diffKeyedStringArrays(after.keysByPath, before.keysByPath);
  const typesAdded = diffKeyedStringArrays(before.typesByPath, after.typesByPath);
  const newEnumValues = diffKeyedStringArrays(before.enumValuesByPath, after.enumValuesByPath);

  const arraysNowEmpty: ShapePath[] = [];
  for (const [path, afterLength] of Object.entries(after.arrayLengthByPath)) {
    const beforeLength = before.arrayLengthByPath[path] ?? 0;
    if (beforeLength > 0 && afterLength === 0) arraysNowEmpty.push(path);
  }

  return { keysAdded, keysRemoved, typesAdded, newEnumValues, arraysNowEmpty };
}

/** True if a diff has nothing worth reporting — every field of every *ByPath record is empty. */
export function isShapeDiffEmpty(diff: ShapeDiff): boolean {
  return (
    Object.keys(diff.keysAdded).length === 0 &&
    Object.keys(diff.keysRemoved).length === 0 &&
    Object.keys(diff.typesAdded).length === 0 &&
    Object.keys(diff.newEnumValues).length === 0 &&
    diff.arraysNowEmpty.length === 0
  );
}

/** Render a diff as human-readable lines for `capture:check`'s console report. */
export function formatShapeDiff(diff: ShapeDiff): string[] {
  const lines: string[] = [];
  for (const [path, keys] of Object.entries(diff.keysAdded)) {
    lines.push(`+ key added at ${path || '(root)'}: ${keys.join(', ')}`);
  }
  for (const [path, keys] of Object.entries(diff.keysRemoved)) {
    lines.push(`- key removed at ${path || '(root)'}: ${keys.join(', ')}`);
  }
  for (const [path, types] of Object.entries(diff.typesAdded)) {
    lines.push(`~ new type at ${path}: ${types.join(', ')}`);
  }
  for (const [path, values] of Object.entries(diff.newEnumValues)) {
    lines.push(`~ new value at ${path}: ${values.join(', ')}`);
  }
  for (const path of diff.arraysNowEmpty) {
    lines.push(`! array now empty at ${path} (was non-empty)`);
  }
  return lines;
}
