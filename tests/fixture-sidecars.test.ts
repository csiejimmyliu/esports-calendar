/**
 * Every committed fixture has a sidecar in the same, validated shape.
 *
 * Three separate sessions have each written `.meta.json` in a different shape (see the history
 * note in scripts/capture-lib.ts and src/fixtures/sidecar.ts), and nothing ever checked that any
 * of them agreed. This is that check: every `.json` under fixtures/ has a `.meta.json`, every
 * sidecar parses against the shared schema, and every fixture explicitly declares whether it can
 * be re-captured (and if so, how) or explicitly declares why not — never silent about which.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FIXTURES_ROOT, listFixtures } from '../scripts/capture-lib.js';
import { FixtureSidecar } from '../src/fixtures/sidecar.js';

describe('fixture sidecars', () => {
  it('every fixture has a sidecar and every sidecar validates', async () => {
    const entries = await listFixtures();
    expect(entries.length).toBeGreaterThan(0);

    for (const entry of entries) {
      const metaText = await readFile(join(FIXTURES_ROOT, entry.metaPath), 'utf8').catch(() => {
        throw new Error(`${entry.jsonPath} has no sidecar at ${entry.metaPath}`);
      });
      const raw: unknown = JSON.parse(metaText);
      const result = FixtureSidecar.safeParse(raw);
      if (!result.success) {
        throw new Error(`${entry.metaPath} failed schema validation: ${result.error.message}`);
      }

      // The sidecar's own `fixture` field should name the file it describes, so a copy-pasted
      // sidecar with a stale `fixture` value is caught rather than silently misdescribing its file.
      const expectedName = entry.jsonPath.split('/').pop();
      expect(result.data.fixture).toBe(expectedName);
    }
  });

  it('every capturable fixture names an endpoint and params; every non-capturable one gives a reason', async () => {
    const entries = await listFixtures();
    for (const entry of entries) {
      const raw: unknown = JSON.parse(await readFile(join(FIXTURES_ROOT, entry.metaPath), 'utf8'));
      const sidecar = FixtureSidecar.parse(raw);
      if (sidecar.recapture.capturable) {
        expect(sidecar.recapture.endpoint.length).toBeGreaterThan(0);
        expect(Object.keys(sidecar.recapture.params).length).toBeGreaterThan(0);
      } else {
        expect(sidecar.recapture.reason.length).toBeGreaterThan(0);
      }
    }
  });

  it('lists at least one non-capturable fixture with a reason on record (gql, VALORANT, or BLAST)', async () => {
    // Guards against the schema silently accepting "capturable: true" for everything, which would
    // defeat the point — the honest answer for several fixtures in this tree really is "no".
    const entries = await listFixtures();
    let sawNonCapturable = false;
    for (const entry of entries) {
      const raw: unknown = JSON.parse(await readFile(join(FIXTURES_ROOT, entry.metaPath), 'utf8'));
      const sidecar = FixtureSidecar.parse(raw);
      if (!sidecar.recapture.capturable) sawNonCapturable = true;
    }
    expect(sawNonCapturable).toBe(true);
  });
});
