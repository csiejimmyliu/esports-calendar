/**
 * Compare every capturable committed fixture against a fresh live response, and report SHAPE
 * differences — new/missing keys, a field that started being null, an enum value never seen
 * before, a collection that dropped to zero rows. Never compares bytes: two captures taken
 * minutes apart differ in every match's time and score, so a byte diff is 100% red and carries no
 * information (see src/fixtures/shape.ts).
 *
 * Writes nothing. This is the drift-detection half of the fixture doctrine in fixtures/README.md —
 * it turns "did Riot change something we depend on" from a question only answerable by re-reading
 * the golden fixtures by eye into a command with an exit code.
 *
 * Usage:
 *   RIOT_ESPORTS_API_KEY=... npm run capture:check
 *   RIOT_ESPORTS_API_KEY=... npm run capture:check -- riot-lol/rest_getSchedule.json
 *
 * With no arguments, checks every capturable fixture under fixtures/. Non-capturable fixtures
 * (VALORANT, CS2, the two Riot fixtures with no recorded recapture request) are listed and
 * skipped, never silently ignored — CLAUDE.md: "no silent caps."
 *
 * Bounded and polite: at most MAX_REQUESTS_PER_RUN live requests per invocation, sequential,
 * spaced MIN_REQUEST_SPACING_MS apart. If more capturable fixtures exist than the cap allows, the
 * excess is reported as skipped rather than silently dropped.
 */

import {
  FIXTURES_ROOT,
  listFixtures,
  loadJson,
  loadSidecar,
  makeClient,
  apiKeyFromEnv,
  politeSequential,
} from './capture-lib.js';
import { applyTransform } from '../src/fixtures/sidecar.js';
import { summarizeShape, diffShape, isShapeDiffEmpty, formatShapeDiff } from '../src/fixtures/shape.js';

async function main(): Promise<void> {
  const requested = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const apiKey = apiKeyFromEnv();
  const client = makeClient(apiKey);

  const all = await listFixtures();
  const targets = requested.length > 0 ? all.filter((f) => requested.includes(f.jsonPath)) : all;

  if (requested.length > 0) {
    const missing = requested.filter((r) => !all.some((f) => f.jsonPath === r));
    for (const m of missing) process.stderr.write(`no such fixture: ${m}\n`);
  }

  const capturable: { entry: (typeof targets)[number]; endpoint: string; params: Record<string, string>; transform: Parameters<typeof applyTransform>[1] }[] = [];
  const skipped: { path: string; reason: string }[] = [];

  for (const entry of targets) {
    const sidecar = await loadSidecar(FIXTURES_ROOT, entry);
    if (!sidecar.recapture.capturable) {
      skipped.push({ path: entry.jsonPath, reason: sidecar.recapture.reason });
      continue;
    }
    capturable.push({
      entry,
      endpoint: sidecar.recapture.endpoint,
      params: sidecar.recapture.params,
      transform: sidecar.recapture.transform,
    });
  }

  process.stdout.write(`${String(capturable.length)} capturable, ${String(skipped.length)} skipped:\n`);
  for (const s of skipped) process.stdout.write(`  SKIP  ${s.path} — ${s.reason}\n`);
  process.stdout.write('\n');

  const { results, skipped: overCap } = await politeSequential(
    capturable,
    (c) => `${c.entry.jsonPath} (${c.endpoint})`,
    async (c) => {
      const committed = await loadJson(FIXTURES_ROOT, c.entry.jsonPath);
      const live = await client.get(c.endpoint, c.params);
      const liveTransformed = applyTransform(live.json, c.transform);
      const diff = diffShape(summarizeShape(committed), summarizeShape(liveTransformed));
      return diff;
    },
  );

  if (overCap.length > 0) {
    process.stdout.write(
      `\nSTOPPED at the ${String(capturable.length - overCap.length)}-request cap for this run. ` +
        `Not checked: ${overCap.map((c) => c.entry.jsonPath).join(', ')}\n`,
    );
  }

  let anyDrift = false;
  for (const { item, result } of results) {
    if (isShapeDiffEmpty(result)) {
      process.stdout.write(`  OK    ${item.entry.jsonPath}\n`);
      continue;
    }
    anyDrift = true;
    process.stdout.write(`  DRIFT ${item.entry.jsonPath}\n`);
    for (const line of formatShapeDiff(result)) process.stdout.write(`          ${line}\n`);
  }

  if (anyDrift) {
    process.stdout.write('\nShape drift found. Review before trusting the parser against live data.\n');
    process.exitCode = 1;
  } else {
    process.stdout.write('\nNo shape drift.\n');
  }
}

try {
  await main();
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
