/**
 * Re-capture ONE fixture and apply its own recorded `recapture.transform`, so the recapture
 * ritual in fixtures/README.md has a tool: fetch live, transform, diff against what is committed,
 * and only write over the committed file if told to.
 *
 * By default this writes `<fixture>.new.json` next to the original and leaves the original alone.
 * Reading the shape diff between old and new is the point — a fixture may have quietly lost the
 * edge case it existed to cover (e.g. a match that was `result: null` when captured has since been
 * played), and that has to be a human decision, not a side effect of running a command. Pass
 * `--write` to overwrite the committed fixture once you've reviewed the diff and decided to.
 *
 * Usage:
 *   RIOT_ESPORTS_API_KEY=... npm run capture:refresh -- riot-lol/rest_getTeams.json
 *   RIOT_ESPORTS_API_KEY=... npm run capture:refresh -- riot-lol/rest_getTeams.json --write
 *
 * This does NOT update FIXTURE_CAPTURED_AT in tests/fixtures.ts, and does not touch the sidecar's
 * capturedOn. Both are deliberate follow-ups once the new content has been reviewed, per
 * fixtures/README.md.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { FIXTURES_ROOT, loadJson, loadSidecar, makeClient, apiKeyFromEnv } from './capture-lib.js';
import { applyTransform } from '../src/fixtures/sidecar.js';
import { summarizeShape, diffShape, isShapeDiffEmpty, formatShapeDiff } from '../src/fixtures/shape.js';

function usage(message: string): never {
  process.stderr.write(`${message}\n\nusage: npm run capture:refresh -- <fixture.json path, relative to fixtures/> [--write]\n`);
  process.exit(2);
}

/** Row count of whichever top-level collection this endpoint returns, if recognised — same shape
 *  the original capture-fixture.ts reported, kept here so refresh prints a comparable summary. */
function countRows(json: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof json !== 'object' || json === null) return out;
  const data = (json as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return out;
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (Array.isArray(value)) out[key] = value.length;
    else if (typeof value === 'object' && value !== null) {
      for (const [k2, v2] of Object.entries(value as Record<string, unknown>)) {
        if (Array.isArray(v2)) out[`${key}.${k2}`] = v2.length;
      }
    }
  }
  return out;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const write = argv.includes('--write');
  const positional = argv.filter((a) => !a.startsWith('--'));
  const fixturePath = positional[0];
  if (fixturePath === undefined) usage('a fixture path is required');

  const apiKey = apiKeyFromEnv();
  const client = makeClient(apiKey);

  const metaPath = fixturePath.replace(/\.json$/, '.meta.json');
  const sidecar = await loadSidecar(FIXTURES_ROOT, { jsonPath: fixturePath, metaPath });
  if (!sidecar.recapture.capturable) {
    process.stderr.write(`${fixturePath} is not capturable: ${sidecar.recapture.reason}\n`);
    process.exit(1);
  }

  const committed = await loadJson(FIXTURES_ROOT, fixturePath);
  const live = await client.get(sidecar.recapture.endpoint, sidecar.recapture.params);
  const refreshed = applyTransform(live.json, sidecar.recapture.transform);

  const diff = diffShape(summarizeShape(committed), summarizeShape(refreshed));
  process.stdout.write(`row counts before: ${JSON.stringify(countRows(committed))}\n`);
  process.stdout.write(`row counts after:  ${JSON.stringify(countRows(refreshed))}\n\n`);

  if (isShapeDiffEmpty(diff)) {
    process.stdout.write('No shape difference from the committed fixture.\n');
  } else {
    process.stdout.write('Shape differences from the committed fixture:\n');
    for (const line of formatShapeDiff(diff)) process.stdout.write(`  ${line}\n`);
  }

  const outPath = join(FIXTURES_ROOT, fixturePath);
  const draftPath = write ? outPath : `${outPath}.new.json`;
  await writeFile(draftPath, `${JSON.stringify(refreshed, null, 2)}\n`);

  if (write) {
    process.stdout.write(
      `\nWrote ${fixturePath} directly (--write). Remember to: update this sidecar's capturedOn, ` +
        `and if this is riot-lol/rest_getSchedule.json or another test-clock-pinned fixture, move ` +
        `FIXTURE_CAPTURED_AT in tests/fixtures.ts to match.\n`,
    );
  } else {
    process.stdout.write(
      `\nWrote a draft to ${fixturePath}.new.json — the committed fixture is unchanged. Review the ` +
        `diff above, check for edge cases the old fixture covered that this one no longer does, ` +
        `then re-run with --write to replace it.\n`,
    );
  }
}

try {
  await main();
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
