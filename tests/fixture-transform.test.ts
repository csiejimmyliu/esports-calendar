/**
 * Proves the sidecar's `recapture.transform` is executable truth, not prose nobody has run.
 *
 * fixtures/riot-lol/rest_getTeams.meta.json describes, in English, how the committed 71-row
 * rest_getTeams.json was derived from the full 1568-row response: strip `players`, then keep only
 * 71 specific ids. As of this change that description is also a `recapture.transform` array of
 * executable ops. This test applies it to the committed full fixture
 * (fixtures/riot-lol/rest_getTeams_full.json) and asserts the result is identical to the committed
 * trimmed fixture — the same guarantee CLAUDE.md asks every fixture's provenance to have, checked
 * by the test suite instead of trusted from a paragraph.
 */

import { describe, expect, it } from 'vitest';

import { applyTransform, FixtureSidecar } from '../src/fixtures/sidecar.js';
import { loadFixture } from './fixtures.js';

describe('rest_getTeams.json is reproducible from rest_getTeams_full.json', () => {
  it('applying the recorded transform to the full capture reproduces the committed trimmed fixture byte-for-byte (as parsed JSON)', () => {
    const sidecarRaw = loadFixture('riot-lol/rest_getTeams.meta.json');
    const sidecar = FixtureSidecar.parse(sidecarRaw);
    expect(sidecar.recapture.capturable).toBe(true);
    if (!sidecar.recapture.capturable) throw new Error('unreachable');

    const full = loadFixture('riot-lol/rest_getTeams_full.json');
    const committed = loadFixture('riot-lol/rest_getTeams.json');

    const reproduced = applyTransform(full, sidecar.recapture.transform);

    expect(reproduced).toEqual(committed);
  });

  it('neither committed fixture carries players — both already had stripField(players) applied when written', () => {
    // rest_getTeams_full.json was generated offline by applying this same transform's stripField
    // step to the ungitignored, never-committed rest_getTeams_en.json (see its own .meta.json
    // provenance note), so by the time it reaches this repo `players` is already gone from it too.
    // This asserts the *output* guarantee that actually matters — no committed fixture anywhere in
    // this tree carries player names — rather than re-deriving it from a file that cannot exist in
    // a fresh clone.
    for (const path of ['riot-lol/rest_getTeams.json', 'riot-lol/rest_getTeams_full.json']) {
      const doc = loadFixture(path) as { data: { teams: Record<string, unknown>[] } };
      expect(doc.data.teams.length).toBeGreaterThan(0);
      expect(doc.data.teams.every((t) => !('players' in t))).toBe(true);
    }
  });
});
