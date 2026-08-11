/**
 * Stage 0 CLI: print the next N days of one league's matches in a given timezone.
 *
 *   tsx src/cli/next-matches.ts --league lck --days 7 --tz Asia/Taipei --now 2026-08-09T00:00:00Z
 *   tsx src/cli/next-matches.ts --league lck --live
 *
 * Defaults to the committed fixture. `--live` goes upstream.
 *
 * Two behaviours that are requirements, not polish:
 *   - Spoiler-free by default (FR-3). Scores print only with --spoilers.
 *   - A failed canary exits non-zero. An empty calendar must be loud.
 */

import { readFile } from 'node:fs/promises';
import process from 'node:process';

import { createLeagueConfig } from '../config/leagues.js';
import type { LeagueConfig } from '../config/leagues.js';
import { fixedClock, systemClock } from '../core/time.js';
import { formatWarning } from '../core/warnings.js';
import { RiotRestClient } from '../sources/riot/rest/client.js';
import {
  createRiotRestLolAdapter,
  fixtureTransport,
  httpTransport,
  GLOBAL_SCOPE,
} from '../sources/riot/rest/adapter.js';
import type { RiotRestTransport } from '../sources/riot/rest/adapter.js';
import { formatMatchLine, parseArgs, selectUpcoming, tallyResolution } from './format.js';

// Public, static, already committed to .env.example. Overridable via env.
const DEFAULT_API_KEY = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';
const DEFAULT_USER_AGENT = 'esports-calendar/0.1 (+https://github.com/csiejimmyliu/esports-calendar)';

const readJson = async (url: URL): Promise<unknown> => JSON.parse(await readFile(url, 'utf8'));

async function loadFixtureTransport(scheduleFixture: string): Promise<RiotRestTransport> {
  const read = (name: string): Promise<unknown> =>
    readJson(new URL(`../../fixtures/riot-lol/${name}`, import.meta.url));
  return fixtureTransport({
    schedule: await read(scheduleFixture),
    leagues: await read('rest_getLeagues.json'),
    teams: await read('rest_getTeams.json'),
  });
}

/**
 * The tier table is read here, at the entry point, and injected downwards. The adapter never
 * touches the filesystem — see createRiotRestLolAdapter.
 */
async function loadLeagueConfig(): Promise<LeagueConfig> {
  return createLeagueConfig(await readJson(new URL('../../config/leagues.json', import.meta.url)));
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  /**
   * A fixture-backed run must never read the wall clock: the fixture's matches are fixed in time,
   * so "the next 7 days" is only meaningful relative to when it was captured. Without --now, this
   * same command silently returns nothing a few weeks from now, for a reason that has nothing to
   * do with the code.
   */
  const clock = args.now === null ? systemClock : fixedClock(args.now);
  if (args.now === null && !args.live) {
    process.stderr.write(
      'warning: reading a fixture with the system clock. Pass --now to pin the reference time.\n',
    );
  }

  const transport = args.live
    ? httpTransport(
        new RiotRestClient({
          apiKey: process.env['RIOT_ESPORTS_API_KEY'] ?? DEFAULT_API_KEY,
          userAgent: process.env['HTTP_USER_AGENT'] ?? DEFAULT_USER_AGENT,
        }),
      )
    : await loadFixtureTransport(args.fixture);

  const adapter = createRiotRestLolAdapter(transport, await loadLeagueConfig());
  const result = await adapter.fetchMatches(GLOBAL_SCOPE);

  const now = clock.now();
  const selected = selectUpcoming(result.items, { leagueSlug: args.league, days: args.days, now });

  const header = `${args.league.toUpperCase()} — next ${String(args.days)} days from ${now.toISOString()} (${args.tz})`;
  process.stdout.write(`${header}\n${'-'.repeat(header.length)}\n`);
  if (selected.length === 0) process.stdout.write('(no matches)\n');
  for (const match of selected) {
    process.stdout.write(`${formatMatchLine(match, args.tz, args.spoilers)}\n`);
  }
  const tally = tallyResolution(selected);
  process.stdout.write(
    `\n${String(selected.length)} match(es) selected from ${String(result.items.length)} parsed; ` +
      `${String(result.diagnostics.requestCount)} upstream request(s), ${String(result.diagnostics.bytes)} bytes\n` +
      `team ids: ${String(tally.resolved)} resolved, ${String(tally.unidentified)} unidentified, ` +
      `${String(tally.tbd)} TBD (team table: ${String(result.diagnostics['teamTableSize'] ?? 0)} rows)\n`,
  );

  for (const w of result.warnings) process.stderr.write(`${formatWarning(w)}\n`);

  // Semantic canaries: content assertions, not liveness checks. A source returning 200 with rows
  // that do not include LCK is a failure an HTTP-level check cannot see.
  let failed = false;
  for (const canary of adapter.canaries) {
    const verdict = canary.check(result.items, now);
    process.stderr.write(`canary ${canary.key}: ${verdict.ok ? 'ok' : 'FAILED'} — ${verdict.detail}\n`);
    if (!verdict.ok) failed = true;
  }

  return failed ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exitCode = 1;
  });
