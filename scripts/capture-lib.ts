/**
 * Shared plumbing for the three capture CLIs (capture, capture:check, capture:refresh).
 *
 * Build-time only, like the rest of scripts/ — CLAUDE.md is explicit that agents and ad hoc
 * tooling never sit on the runtime sync path. Nothing here is imported by src/.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { RiotRestClient, IDENTITY_LOCALE } from '../src/sources/riot/rest/client.js';
import { FixtureSidecar } from '../src/fixtures/sidecar.js';

export const FIXTURES_ROOT = new URL('../fixtures/', import.meta.url).pathname;
export const USER_AGENT = 'esports-calendar/0.1 (+https://github.com/csiejimmyliu/esports-calendar)';

/** CLAUDE.md Conduct: polite polling. capture:check hits several fixtures in one run, so this cap
 *  and this pacing apply across the whole invocation, not per fixture. Matches the limits an
 *  earlier data-capture task was briefed under: sequential, >=1s apart, <=20 requests total. */
export const MAX_REQUESTS_PER_RUN = 20;
export const MIN_REQUEST_SPACING_MS = 1000;

export interface FixtureEntry {
  /** Path to the `.json`, relative to fixtures/. For a crawl entry, the directory itself (no
   *  extension) — the basename other tooling matches against `sidecar.fixture`. */
  jsonPath: string;
  /** Path to the `.meta.json`, relative to fixtures/. For a crawl entry, `<dir>/crawl.meta.json`. */
  metaPath: string;
  kind: 'single' | 'crawl';
  /** Crawl entries only: page files, relative to fixtures/, in page order (page1, page2, …,
   *  never lexical order — page10 must not sort before page2). */
  pages?: string[];
}

const CRAWL_META_NAME = 'crawl.meta.json';

/** `page12.json` -> 12, for numeric (not lexical) ordering. */
function pageNumber(filename: string): number {
  const match = /^page(\d+)\.json$/.exec(filename);
  if (!match) throw new Error(`crawl page file does not match 'page<n>.json': ${filename}`);
  return Number(match[1]);
}

/**
 * Walk fixtures/ recursively. Pairs every `<name>.json` with its `<name>.meta.json`, EXCEPT a
 * directory containing `crawl.meta.json` — Stage 0.7's multi-page fixture shape — which is
 * emitted as one entry and not walked into, so its `page*.json` children are never separately
 * paired with a sidecar that does not exist for them (a per-page sidecar cannot honestly describe
 * a `pageToken` recapture — see the doc comment on `CrawlSpec`).
 */
export async function listFixtures(root: string = FIXTURES_ROOT): Promise<FixtureEntry[]> {
  const out: FixtureEntry[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    if (entries.some((e) => e.isFile() && e.name === CRAWL_META_NAME)) {
      const pageFiles = entries
        .filter((e) => e.isFile() && /^page\d+\.json$/.exec(e.name))
        .map((e) => e.name)
        .sort((a, b) => pageNumber(a) - pageNumber(b));
      out.push({
        jsonPath: relative(root, dir),
        metaPath: relative(root, join(dir, CRAWL_META_NAME)),
        kind: 'crawl',
        pages: pageFiles.map((name) => relative(root, join(dir, name))),
      });
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name.endsWith('.json') && !entry.name.endsWith('.meta.json')) {
        const metaFull = full.replace(/\.json$/, '.meta.json');
        out.push({
          jsonPath: relative(root, full),
          metaPath: relative(root, metaFull),
          kind: 'single',
        });
      }
    }
  }

  await walk(root);
  return out.sort((a, b) => a.jsonPath.localeCompare(b.jsonPath));
}

export async function loadJson(root: string, relPath: string): Promise<unknown> {
  return JSON.parse(await readFile(join(root, relPath), 'utf8'));
}

/** Parse and validate a sidecar. Throws with the fixture name in the message on a bad sidecar,
 *  rather than a bare zod error naming only a JSON path nobody can place. */
export async function loadSidecar(root: string, entry: FixtureEntry): Promise<FixtureSidecar> {
  const raw = await loadJson(root, entry.metaPath);
  const result = FixtureSidecar.safeParse(raw);
  if (!result.success) {
    throw new Error(`${entry.metaPath} does not match the sidecar schema: ${result.error.message}`);
  }
  return result.data;
}

export function apiKeyFromEnv(): string {
  const key = process.env['RIOT_ESPORTS_API_KEY'];
  if (key === undefined || key === '') {
    throw new Error('RIOT_ESPORTS_API_KEY is not set; see .env.example');
  }
  return key;
}

export function makeClient(apiKey: string): RiotRestClient {
  return new RiotRestClient({ apiKey, userAgent: USER_AGENT });
}

/** Reconstruct the exact URL a request would hit, for the sidecar and for console output. `hl` is
 *  injected here even when the caller didn't pass it, because the client pins it unconditionally. */
export function describeUrl(endpoint: string, params: Record<string, string>): string {
  const url = new URL(`https://esports-api.lolesports.com/persisted/gw/${endpoint}`);
  url.searchParams.set('hl', IDENTITY_LOCALE);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface CrawlPage {
  json: unknown;
  bytes: number;
}

/**
 * Follow `data.schedule.pages.newer` forward, sequential and polite (spaced MIN_REQUEST_SPACING_MS
 * apart, same as politeSequential), until it is null or `maxPages` is reached. This is the
 * build-time twin of the adapter's own `crawlSchedule` in src/sources/riot/rest/adapter.ts — same
 * termination rule (`pages.newer === null`, never a time-based guess about page width), simpler
 * because a capture run is one-shot and does not need the runtime's repeated-token guard or
 * partial-failure recovery: a capture that errors mid-crawl should fail the whole command, loudly,
 * not silently write a truncated fixture.
 */
export async function crawlSchedule(
  client: RiotRestClient,
  params: Record<string, string>,
  maxPages: number,
): Promise<{ pages: CrawlPage[]; complete: boolean }> {
  const pages: CrawlPage[] = [];
  let token: string | undefined;

  for (let i = 0; i < maxPages; i++) {
    if (i > 0) await sleep(MIN_REQUEST_SPACING_MS);
    const requestParams = token === undefined ? params : { ...params, pageToken: token };
    const res = await client.get('getSchedule', requestParams);
    pages.push(res);

    const pageFields = (res.json as { data?: { schedule?: { pages?: { newer: string | null } } } })?.data?.schedule
      ?.pages;
    if (pageFields === undefined || pageFields.newer === null) {
      return { pages, complete: true };
    }
    token = pageFields.newer;
  }

  return { pages, complete: false };
}

/**
 * Run a bounded, sequential, spaced-out fetch across several fixtures. Never fires two requests
 * concurrently and never exceeds MAX_REQUESTS_PER_RUN in one process — a hard cap, not a suggestion,
 * because this CLI can be pointed at every fixture in the tree in one invocation.
 *
 * Returns the results for what ran, plus the list of items skipped once the cap was hit — printed
 * by the caller so a truncated run is visible rather than silently partial (CLAUDE.md: no silent caps).
 */
export async function politeSequential<T, R>(
  items: T[],
  label: (item: T) => string,
  fn: (item: T) => Promise<R>,
): Promise<{ results: { item: T; result: R }[]; skipped: T[] }> {
  const results: { item: T; result: R }[] = [];
  const runnable = items.slice(0, MAX_REQUESTS_PER_RUN);
  const skipped = items.slice(MAX_REQUESTS_PER_RUN);

  for (let i = 0; i < runnable.length; i++) {
    const item = runnable[i] as T;
    if (i > 0) await sleep(MIN_REQUEST_SPACING_MS);
    process.stderr.write(`[${String(i + 1)}/${String(runnable.length)}] ${label(item)}\n`);
    results.push({ item, result: await fn(item) });
  }

  return { results, skipped };
}
