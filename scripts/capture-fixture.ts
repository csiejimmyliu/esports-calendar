/**
 * Re-capture a Riot REST fixture together with the sidecar that makes it re-capturable.
 *
 * This exists because of a specific problem. Several load-bearing figures in
 * docs/sources/lolesports-rest.md were measured against the full 1568-row `getTeams` response,
 * which is 1.5 MB and deliberately not in version control. The committed fixture is trimmed to 71
 * rows and cannot reproduce those figures, so before this script existed the numbers were merely
 * *disclosed* as unverifiable. Now they are re-derivable: run this, then re-run the measurement.
 *
 * It writes two files:
 *   <out>.json            the response, verbatim
 *   <out>.meta.json       the request that produced it — full URL, every parameter, non-secret
 *                         headers, capture timestamp, and byte/row counts
 *
 * The api key is never written to the sidecar. CLAUDE.md requires every fixture to record its
 * request; it does not require leaking credentials into the repo.
 *
 * Usage:
 *   RIOT_API_KEY=... npm run capture -- getTeams fixtures/riot-lol/rest_getTeams_full
 *   RIOT_API_KEY=... npm run capture -- getSchedule out/sched --leagueId=98767991310872058
 *
 * Nothing here runs at runtime. It is a build-time tool, like the agents that wrote the adapters.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { RIOT_REST_BASE, RiotRestClient, IDENTITY_LOCALE } from '../src/sources/riot/rest/client.js';

const USER_AGENT = 'esports-calendar/0.1 (+https://github.com/csiejimmyliu/esports-calendar)';

function usage(message: string): never {
  process.stderr.write(`${message}\n\nusage: npm run capture -- <endpoint> <outPathWithoutExtension> [--key=value ...]\n`);
  process.exit(2);
}

/** Count the rows of whichever top-level collection this endpoint returns, if we recognise one. */
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
  const positional = argv.filter((a) => !a.startsWith('--'));
  const endpoint = positional[0];
  const outBase = positional[1];
  if (endpoint === undefined || outBase === undefined) usage('endpoint and output path are both required');

  const params: Record<string, string> = {};
  for (const flag of argv.filter((a) => a.startsWith('--'))) {
    const eq = flag.indexOf('=');
    if (eq === -1) usage(`parameter ${flag} needs a value, as --name=value`);
    params[flag.slice(2, eq)] = flag.slice(eq + 1);
  }

  const apiKey = process.env['RIOT_API_KEY'];
  if (apiKey === undefined || apiKey === '') {
    usage('RIOT_API_KEY is not set; see .env.example');
  }

  const client = new RiotRestClient({ apiKey, userAgent: USER_AGENT });
  const capturedAt = new Date().toISOString();
  const res = await client.get(endpoint, params);

  // Reconstruct exactly what the client sent, so the sidecar is a replayable record rather than a
  // description of one. `hl` is pinned inside the client and must appear here even though the
  // caller never passed it.
  const url = new URL(`${RIOT_REST_BASE}/${endpoint}`);
  url.searchParams.set('hl', IDENTITY_LOCALE);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const meta = {
    endpoint,
    url: url.toString(),
    queryParams: { hl: IDENTITY_LOCALE, ...params },
    headers: {
      'x-api-key': '<public static key, see .env.example / RIOT_API_KEY>',
      'user-agent': USER_AGENT,
      accept: 'application/json',
    },
    capturedAt,
    bytes: res.bytes,
    rowCounts: countRows(res.json),
    verbatim: 'verbatim' as const,
    recapture: `RIOT_API_KEY=... npm run capture -- ${endpoint} ${outBase}${Object.entries(params)
      .map(([k, v]) => ` --${k}=${v}`)
      .join('')}`,
  };

  await mkdir(dirname(outBase), { recursive: true });
  await writeFile(`${outBase}.json`, `${JSON.stringify(res.json, null, 2)}\n`);
  await writeFile(`${outBase}.meta.json`, `${JSON.stringify(meta, null, 2)}\n`);

  process.stdout.write(
    `${outBase}.json      ${String(res.bytes)} bytes\n` +
      `${outBase}.meta.json  ${JSON.stringify(meta.rowCounts)}\n`,
  );
}

await main();
