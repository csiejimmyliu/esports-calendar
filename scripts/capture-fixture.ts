/**
 * Capture a brand-new Riot REST fixture together with a sidecar in the same shape as every
 * committed one (`fixture/source/request/capturedOn/contents/recapture`).
 *
 * This is the tool CLAUDE.md refers to when it says "use `npm run capture` rather than saving a
 * response by hand" — a hand-saved fixture is how the rest_getSchedule.json hl=zh-TW discrepancy
 * went unrecorded for two days. It writes both halves together so a fixture can never exist
 * without the sidecar that makes it re-capturable.
 *
 * For an EXISTING fixture, prefer `npm run capture:refresh <fixture>` instead — it reads the
 * fixture's own recorded `recapture.transform` and reports a shape diff before writing anything.
 * This script always produces a fresh, untrimmed capture with an empty transform; trimming has to
 * be designed and recorded by hand afterwards, the way rest_getTeams.json's was.
 *
 * Usage:
 *   RIOT_ESPORTS_API_KEY=... npm run capture -- getSchedule fixtures/riot-lol/rest_getSchedule_new
 *   RIOT_ESPORTS_API_KEY=... npm run capture -- getSchedule out/sched --leagueId=98767991310872058
 *
 * Pass --crawl for a Stage 0.7 multi-page schedule crawl instead of a single call: only valid with
 * endpoint getSchedule. Writes page1.json..pageN.json plus one crawl.meta.json (not a sidecar per
 * page — see the CrawlSpec doc comment in src/fixtures/sidecar.ts for why) into a DIRECTORY at
 * outPathWithoutExtension, minified rather than pretty-printed (a crawl corpus is read by tests,
 * not by people — see fixtures/README.md).
 *
 *   RIOT_ESPORTS_API_KEY=... npm run capture -- getSchedule fixtures/riot-lol/rest_getSchedule_crawl_new --crawl
 *
 * Nothing here runs at runtime. It is a build-time tool, like the agents that write adapters.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';

import { apiKeyFromEnv, crawlSchedule, describeUrl, makeClient, USER_AGENT } from './capture-lib.js';
import { MAX_SCHEDULE_PAGES } from '../src/sources/riot/rest/adapter.js';

function usage(message: string): never {
  process.stderr.write(`${message}\n\nusage: npm run capture -- <endpoint> <outPathWithoutExtension> [--key=value ...]\n`);
  process.exit(2);
}

/** Count the rows of whichever top-level collection this endpoint returns, if recognised. */
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

/** Latest `startTime` across a page's events, or null for a page with none. ISO 'Z' timestamps
 *  sort correctly as strings, so a plain max works without parsing dates. */
function latestStartTime(pageJson: unknown): string | null {
  const events = (pageJson as { data?: { schedule?: { events?: { startTime?: string }[] } } })?.data?.schedule
    ?.events;
  if (!Array.isArray(events) || events.length === 0) return null;
  const times = events.map((e) => e.startTime).filter((t): t is string => typeof t === 'string');
  return times.length === 0 ? null : ([...times].sort().at(-1) as string);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const crawl = argv.includes('--crawl');
  const positional = argv.filter((a) => !a.startsWith('--'));
  const endpoint = positional[0];
  const outBase = positional[1];
  if (endpoint === undefined || outBase === undefined) usage('endpoint and output path are both required');

  const params: Record<string, string> = {};
  for (const flag of argv.filter((a) => a.startsWith('--') && a !== '--crawl')) {
    const eq = flag.indexOf('=');
    if (eq === -1) usage(`parameter ${flag} needs a value, as --name=value`);
    params[flag.slice(2, eq)] = flag.slice(eq + 1);
  }

  const apiKey = apiKeyFromEnv();
  const client = makeClient(apiKey);
  const capturedAt = new Date().toISOString();

  if (crawl) {
    if (endpoint !== 'getSchedule') usage('--crawl is only valid with endpoint getSchedule');

    const result = await crawlSchedule(client, params, MAX_SCHEDULE_PAGES);
    await mkdir(outBase, { recursive: true });
    for (const [i, page] of result.pages.entries()) {
      await writeFile(join(outBase, `page${String(i + 1)}.json`), `${JSON.stringify(page.json)}\n`);
    }

    const horizonUtc = result.pages.length > 0 ? latestStartTime(result.pages[result.pages.length - 1]!.json) : null;
    const totalEvents = result.pages.reduce(
      (sum, p) => sum + ((p.json as { data?: { schedule?: { events?: unknown[] } } })?.data?.schedule?.events
        ?.length ?? 0),
      0,
    );

    const sidecar = {
      fixture: basename(outBase),
      source: 'riot-rest-lol',
      request: {
        method: 'GET',
        url: describeUrl(endpoint, params),
        queryParams: { hl: 'en-US', ...params },
        pathParams: {},
        headers: {
          'x-api-key': '<public static key, see .env.example RIOT_ESPORTS_API_KEY>',
          'user-agent': USER_AGENT,
          accept: 'application/json',
        },
      },
      capturedOn: capturedAt,
      contents: `Freshly captured crawl, untrimmed and UNREVIEWED. ${String(result.pages.length)} page(s), ${String(totalEvents)} events total, complete=${String(result.complete)}, horizon ${String(horizonUtc)}.`,
      recapture: {
        capturable: true,
        endpoint,
        params: { hl: 'en-US', ...params },
        transform: [],
        crawl: {
          strategy: 'pageTokenForward' as const,
          pageParam: 'pageToken' as const,
          tokenPath: 'data.schedule.pages.newer',
          terminateWhen: 'tokenPath is null',
          maxPages: MAX_SCHEDULE_PAGES,
          pageFilePattern: 'page{n}.json',
          pagesCaptured: result.pages.length,
          horizonUtc: horizonUtc ?? 'unknown (no events on the last page)',
        },
      },
      recaptureNotes: {
        note:
          'This sidecar was generated by capture-fixture.ts --crawl and has NOT been reviewed. Before ' +
          'committing: confirm result.complete was true (an incomplete crawl here means the page cap ' +
          'or a request failure was hit during CAPTURE, not a Stage 0.7 fetchMatches property — do not ' +
          'commit a capture-time-truncated crawl), check for edge cases the previous crawl fixture ' +
          'covered that this one no longer does, and update pagesCaptured/horizonUtc above if this ' +
          'was re-run after review changed the page count. See fixtures/README.md.',
      },
    };

    await writeFile(join(outBase, 'crawl.meta.json'), `${JSON.stringify(sidecar, null, 2)}\n`);
    process.stdout.write(
      `${outBase}/  ${String(result.pages.length)} pages, ${String(totalEvents)} events, ` +
        `complete=${String(result.complete)}, horizon=${String(horizonUtc)}\n` +
        `\nThis crawl is UNTRIMMED and UNREVIEWED. See recaptureNotes in crawl.meta.json before committing.\n`,
    );
    return;
  }

  const res = await client.get(endpoint, params);
  const url = describeUrl(endpoint, params);

  const sidecar = {
    fixture: `${basename(outBase)}.json`,
    source: 'riot-rest-lol',
    request: {
      method: 'GET',
      url,
      queryParams: { hl: 'en-US', ...params },
      pathParams: {},
      headers: {
        'x-api-key': '<public static key, see .env.example RIOT_ESPORTS_API_KEY>',
        'user-agent': USER_AGENT,
        accept: 'application/json',
      },
    },
    capturedOn: capturedAt,
    contents: `Freshly captured, untrimmed. Row counts: ${JSON.stringify(countRows(res.json))}.`,
    recapture: {
      capturable: true,
      endpoint,
      params: { hl: 'en-US', ...params },
      transform: [],
    },
    recaptureNotes: {
      note:
        'This sidecar was generated by capture-fixture.ts and has NOT been reviewed for trimming ' +
        'or personal data. Before committing: check whether the response needs trimming (size, or ' +
        'a personal-data field like players[]), design the transform by hand if so, and re-run ' +
        'capture:refresh to prove the transform reproduces the trimmed file. See fixtures/README.md.',
    },
  };

  await mkdir(dirname(outBase), { recursive: true });
  await writeFile(`${outBase}.json`, `${JSON.stringify(res.json, null, 2)}\n`);
  await writeFile(`${outBase}.meta.json`, `${JSON.stringify(sidecar, null, 2)}\n`);

  process.stdout.write(
    `${outBase}.json      ${String(res.bytes)} bytes\n` +
      `${outBase}.meta.json  ${JSON.stringify(countRows(res.json))}\n` +
      `\nThis fixture is UNTRIMMED and UNREVIEWED. See recaptureNotes in the sidecar before committing.\n`,
  );
}

try {
  await main();
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
