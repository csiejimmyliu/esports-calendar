/**
 * One-shot sync entry point.
 *
 *   tsx src/cli/sync.ts --source riot-rest-lol --fixture --now 2026-08-12T00:00:00Z
 *   tsx src/cli/sync.ts --source riot-rest-lol --live
 *
 * No scheduler here — this process runs once and exits. A resident worker is future work; this
 * file is deliberately what it will call, not a smaller version of it.
 *
 * Defaults to the committed crawl fixture, same convention as src/cli/next-matches.ts: a
 * fixture-backed run must never read the wall clock, so --now is required unless --live is given.
 * Stage 1b is what makes this load-bearing rather than accepted-and-ignored: `runSync` passes it
 * to every canary's `check(matches, now)`.
 */

import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import process from 'node:process';

import { createLeagueConfig } from '../config/leagues.js';
import type { LeagueConfig } from '../config/leagues.js';
import { fixedClock, systemClock } from '../core/time.js';
import { formatWarning } from '../core/warnings.js';
import { createPool } from '../db/pool.js';
import { migrate } from '../db/migrate.js';
import { findSource } from '../sync/registry.js';
import { classifyRun, runSync } from '../sync/ingest.js';
import { RiotRestClient } from '../sources/riot/rest/client.js';
import { createRiotRestLolAdapter, fixtureTransport, httpTransport } from '../sources/riot/rest/adapter.js';
import type { RiotRestTransport } from '../sources/riot/rest/adapter.js';

const DEFAULT_USER_AGENT = 'esports-calendar/0.1 (+https://github.com/csiejimmyliu/esports-calendar)';

interface Args {
  source: string;
  live: boolean;
  now: string | null;
}

function parseArgs(argv: string[]): Args {
  let source = 'riot-rest-lol';
  let live = false;
  let now: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--source') source = argv[(i += 1)] ?? source;
    else if (arg === '--live') live = true;
    else if (arg === '--now') now = argv[(i += 1)] ?? now;
  }
  return { source, live, now };
}

const readJson = async (url: URL): Promise<unknown> => JSON.parse(await readFile(url, 'utf8'));

async function loadCrawlFixtureTransport(): Promise<RiotRestTransport> {
  const dirUrl = new URL('../../fixtures/riot-lol/rest_getSchedule_crawl_2026-08-12/', import.meta.url);
  const names = readdirSync(dirUrl)
    .filter((n) => /^page\d+\.json$/.exec(n))
    .sort((a, b) => Number(/^page(\d+)\.json$/.exec(a)?.[1]) - Number(/^page(\d+)\.json$/.exec(b)?.[1]));
  const schedule = await Promise.all(names.map((n) => readJson(new URL(n, dirUrl))));
  const read = (name: string): Promise<unknown> =>
    readJson(new URL(`../../fixtures/riot-lol/${name}`, import.meta.url));
  return fixtureTransport({
    schedule,
    leagues: await read('rest_getLeagues.json'),
    teams: await read('rest_getTeams.json'),
  });
}

async function loadLeagueConfig(): Promise<LeagueConfig> {
  return createLeagueConfig(await readJson(new URL('../../config/leagues.json', import.meta.url)));
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  // Ingestion (the matches/leagues/teams themselves) reads no clock — every stored timestamp
  // comes from the fetch. `now` is what the canaries run against (SourceCanary.check), so a
  // fixture-backed run with no --now pinned still must not silently fall back to the wall clock —
  // the same trap src/cli/next-matches.ts guards against.
  const clock = args.now === null ? systemClock : fixedClock(args.now);
  if (args.now === null && !args.live) {
    process.stderr.write(
      'warning: reading a fixture with the system clock. Pass --now to pin the reference time the canaries run against.\n',
    );
  }

  const entry = findSource(args.source);

  let transport: RiotRestTransport;
  if (args.live) {
    const apiKey = process.env['RIOT_ESPORTS_API_KEY'];
    if (apiKey === undefined || apiKey === '') {
      process.stderr.write('RIOT_ESPORTS_API_KEY is not set; see .env.example\n');
      return 2;
    }
    transport = httpTransport(
      new RiotRestClient({ apiKey, userAgent: process.env['HTTP_USER_AGENT'] ?? DEFAULT_USER_AGENT }),
    );
  } else {
    transport = await loadCrawlFixtureTransport();
  }

  const leagueConfig = await loadLeagueConfig();
  const adapter = createRiotRestLolAdapter(transport, leagueConfig);
  const pool = createPool();
  try {
    await migrate(pool);
    const now = clock.now();
    const report = await runSync(pool, entry, adapter, leagueConfig, now);

    process.stdout.write(
      `sync ${report.sourceId}: ${String(report.scopesProcessed)} scope(s) ok, ${String(report.scopesFailed)} failed, ` +
        `${String(report.matchesFetched)} match(es) fetched\n` +
        `  leagues upserted: ${String(report.leaguesUpserted)}\n` +
        `  teams touched: ${String(report.teamsUpserted)}\n` +
        `  matches inserted: ${String(report.matchesInserted)}, updated: ${String(report.matchesUpdated)}, ` +
        `unchanged: ${String(report.matchesUnchanged)}, cancelled: ${String(report.matchesCancelled)}\n`,
    );
    if (report.fatal !== null) process.stderr.write(`fatal: ${report.fatal}\n`);
    for (const f of report.scopeFailures) process.stderr.write(`scope ${f.scopeKey} failed: ${f.message}\n`);
    for (const w of report.warnings) process.stderr.write(`${formatWarning(w)}\n`);
    for (const c of report.canaryResults) {
      process.stderr.write(`canary ${c.key}: ${c.ok ? 'ok' : 'FAILED'} — ${c.detail}\n`);
    }

    // A source-broken run (`failed`) exits non-zero — a deliberately broken source does not fail
    // *this process*, but a caller (a cron job, a health dashboard) still needs to know the run
    // did not land. `degraded` (a scope failed or a canary did not pass, but some data still
    // ingested) exits 0: a wrong-looking calendar beats no calendar, and source_health already
    // recorded the detail for anyone watching.
    return classifyRun(report) === 'failed' ? 1 : 0;
  } finally {
    await pool.end();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exitCode = 1;
  });
