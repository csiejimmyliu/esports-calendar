/**
 * Turns the Stage 0.7 pagination measurement into a test, per CLAUDE.md: "when a claim is
 * upgraded from sampled to verified, encode the evidence as a test, not only as a paragraph."
 *
 * `fixtures/riot-lol/rest_getSchedule_crawl_2026-08-12/` is one forward crawl, captured
 * 2026-08-12, following `data.schedule.pages.newer` until it was null. These assertions are what
 * the adapter's crawl logic (Step 3) and the capture tooling (Step 4) both depend on being true of
 * the committed corpus — not a claim about every future crawl, which `crawl.meta.json`'s
 * `recapture.crawl` block is explicit about (page count and horizon are measurements, not a
 * contract).
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { loadCrawlFixture } from './fixtures.js';
import { FixtureSidecar } from '../src/fixtures/sidecar.js';

const CRAWL_DIR = 'riot-lol/rest_getSchedule_crawl_2026-08-12';
const pages = loadCrawlFixture(CRAWL_DIR) as {
  data: { schedule: { pages?: { older: string | null; newer: string | null }; events: unknown[] } };
}[];

function decode(token: string | null): string | null {
  return token === null ? null : Buffer.from(token, 'base64').toString('utf8');
}

function eventTimes(page: (typeof pages)[number]): string[] {
  return (page.data.schedule.events as { startTime: string }[]).map((e) => e.startTime).sort();
}

function eventIds(page: (typeof pages)[number]): string[] {
  return (page.data.schedule.events as { match?: { id: string } }[])
    .filter((e) => e.match !== undefined)
    .map((e) => e.match!.id);
}

describe('the committed schedule crawl', () => {
  it('has more than one page — otherwise this corpus proves nothing pagination-specific', () => {
    expect(pages.length).toBeGreaterThan(1);
  });

  it('terminates: every page but the last has a non-null newer token, and the last has null', () => {
    pages.slice(0, -1).forEach((p, i) => {
      expect(p.data.schedule.pages?.newer, `page ${String(i + 1)} should have a newer token`).not.toBeNull();
    });
    const last = pages[pages.length - 1] as (typeof pages)[number];
    expect(last.data.schedule.pages?.newer).toBeNull();
  });

  it('every non-null token decodes to newer::<digits>, and none repeats', () => {
    const seen = new Set<string>();
    for (const p of pages) {
      const token = p.data.schedule.pages?.newer ?? null;
      if (token === null) continue;
      const decoded = decode(token);
      expect(decoded).toMatch(/^newer::\d+$/);
      expect(seen.has(token), `token ${token} repeated across pages`).toBe(false);
      seen.add(token);
    }
  });

  it('page spans are contiguous and ascending: each page starts no earlier than the previous ends', () => {
    let prevMax: string | null = null;
    for (const [i, p] of pages.entries()) {
      const times = eventTimes(p);
      expect(times.length, `page ${String(i + 1)} has no events`).toBeGreaterThan(0);
      if (prevMax !== null) {
        expect(times[0]! >= prevMax, `page ${String(i + 1)} starts before the previous page ended`).toBe(true);
      }
      prevMax = times[times.length - 1] as string;
    }
  });

  it('no match id appears on two pages', () => {
    const seen = new Set<string>();
    let dupes = 0;
    for (const p of pages) {
      for (const id of eventIds(p)) {
        if (seen.has(id)) dupes += 1;
        seen.add(id);
      }
    }
    expect(dupes).toBe(0);
  });

  it('totals 436 events across 6 pages — measured on this capture, asserted so drift is visible', () => {
    const total = pages.reduce((sum, p) => sum + p.data.schedule.events.length, 0);
    expect(pages.length).toBe(6);
    expect(total).toBe(436);
  });

  it("the sidecar's pagesCaptured matches the number of page files actually on disk", () => {
    const sidecar = FixtureSidecar.parse(
      JSON.parse(readFileSync(new URL(`../fixtures/${CRAWL_DIR}/crawl.meta.json`, import.meta.url), 'utf8')),
    );
    expect(sidecar.recapture.capturable).toBe(true);
    if (sidecar.recapture.capturable) {
      expect(sidecar.recapture.crawl?.pagesCaptured).toBe(pages.length);
    }
  });
});
