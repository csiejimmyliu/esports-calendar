/**
 * Stage 1a CLI: one-shot sync entry point.
 *
 *   tsx src/cli/sync.ts --source riot-rest-lol --fixture --now 2026-08-12T00:00:00Z
 *   tsx src/cli/sync.ts --source riot-rest-lol --live
 *
 * No scheduler here — this process runs once and exits. Stage 1b adds the resident worker that
 * calls this same runSync on an interval; this file is deliberately what it will call, not a
 * smaller version of it.
 *
 * Defaults to the committed crawl fixture, same convention as src/cli/next-matches.ts: a
 * fixture-backed run must never read the wall clock, so --now is required unless --live is given.
 */

import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import process from 'node:process';

import { createLeagueConfig } from '../config/leagues.js';
import type { LeagueConfig } from '../config/leagues.js';
import { formatWarning } from '../core/warnings.js';
import { createPool } from '../db/pool.js';
import { migrate } from '../db/migrate.js';
import { findSource } from '../sync/registry.js';
import { runSync } from '../sync/ingest.js';
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

  // Ingestion itself reads no clock — every timestamp comes from the fetched matches. --now is
  // accepted anyway, for parity with next-matches.ts and because stage 1b's canary scheduling
  // will need a pinned reference time the moment it lands; a flag that silently does nothing in
  // --live mode is fine, one that silently does nothing against a frozen fixture is the trap
  // CLAUDE.md calls out, so it still warns.
  if (args.now === null && !args.live) {
    process.stderr.write(
      'warning: reading a fixture with no --now pinned. Harmless today (sync reads no clock), ' +
        'but pass --now anyway once stage 1b adds canary scheduling here.\n',
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
    const report = await runSync(pool, entry, adapter, leagueConfig);

    process.stdout.write(
      `sync ${report.sourceId}: ${String(report.scopesProcessed)} scope(s), ${String(report.matchesFetched)} match(es) fetched\n` +
        `  leagues upserted: ${String(report.leaguesUpserted)}\n` +
        `  teams touched: ${String(report.teamsUpserted)}\n` +
        `  matches inserted: ${String(report.matchesInserted)}, updated: ${String(report.matchesUpdated)}, ` +
        `unchanged: ${String(report.matchesUnchanged)}, cancelled: ${String(report.matchesCancelled)}\n`,
    );
    for (const w of report.warnings) process.stderr.write(`${formatWarning(w)}\n`);
    return 0;
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
