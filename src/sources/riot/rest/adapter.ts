/**
 * riot-rest-lol — the only adapter.
 *
 * This was drafted as the *secondary* source, with Riot's GraphQL endpoint as primary because it
 * carries team ids and a trustworthy state field. Both reasons were then removed: `getTeams` supplies
 * team ids outright, and `result == null` determines state exactly (7 of 7 unplayed matches, 0 of 73
 * played ones, over the 2026-08-09 capture). GraphQL is off the roadmap — it needs a persisted query
 * hash tied to a frontend build that this repo never recorded. See docs/sources/lolesports-rest.md.
 *
 * Its one known defect is declared, not hidden: a `lossy-state` warning per corrected match, because
 * the state this adapter reports is inferred rather than read.
 */

import type {
  FetchResult,
  Scope,
  SourceAdapter,
  SourceCanary,
  SourceCapabilities,
  TimeWindow,
} from '../../../core/source.js';
import type { LeagueConfig } from '../../../config/leagues.js';
import type { SourceLeague, SourceMatch } from '../../../core/types.js';
import { WarningCollector } from '../../../core/warnings.js';
import { addDays, parseUtcInstant } from '../../../core/time.js';
import { RiotRestClient } from './client.js';
import type { RawResponse } from './client.js';
import { parseLeagues, parseSchedulePages } from './parse.js';
import { buildTeamIndex, parseTeams } from './teams.js';
import type { TeamIndex } from './teams.js';

/**
 * How bytes are obtained, so the adapter's logic is testable without a network and the CLI can
 * run offline against the committed fixture.
 *
 * This is where multi-request fetching is *hidden*. BLAST will need /matches plus /brackets to
 * produce one match; this source needs getSchedule plus getLeagues. Neither may push that up to
 * the sync layer — the moment the sync layer knows getLeagues exists, the adapter boundary has
 * leaked (NFR-3). What rises instead is `diagnostics.requestCount` and, when a secondary request
 * fails, a `degraded-fetch` warning.
 */
export interface RiotRestTransport {
  /**
   * `pageToken` is `undefined` for the first page of a crawl (Stage 0.7) and thereafter is the
   * previous page's `data.schedule.pages.newer`, verbatim. Absent means "start from now" —
   * `httpTransport` sends no `pageToken` parameter at all in that case, matching the pre-0.7
   * unparameterised call exactly.
   */
  getSchedule(pageToken?: string): Promise<RawResponse>;
  getLeagues(): Promise<RawResponse>;
  /** The team master table. One call per sync run, never one per match. */
  getTeams(): Promise<RawResponse>;
}

export function httpTransport(client: RiotRestClient): RiotRestTransport {
  return {
    getSchedule: (pageToken) => client.get('getSchedule', pageToken === undefined ? {} : { pageToken }),
    getLeagues: () => client.get('getLeagues'),
    getTeams: () => client.get('getTeams'),
  };
}

/**
 * Reads captured responses. Used by the golden-fixture tests and by the CLI's default mode.
 *
 * `schedule` is either one document (every fixture from before Stage 0.7) or an array of pages —
 * a crawl fixture, served in order. Two things this does that a plain array-of-responses would not:
 *
 * 1. **Asserts the token.** Call *n* must arrive with call *n-1*'s `pages.newer`, or it rejects
 *    naming both — turning the double into a checker of the crawl's own correctness, not just a
 *    passive sequencer.
 * 2. **Forces the terminal page's `pages.newer` to `null`, in memory only.** This is the one place
 *    a test double diverges from the bytes on disk in a repo whose fixtures are otherwise verbatim
 *    — and it exists so every fixture captured before crawling existed (whose own `pages.newer`
 *    may be genuinely non-null, mid-schedule) still reads as "one page, done" rather than as a
 *    crawl that needs a page 2 nothing supplies. The real terminal-`null` path is still exercised:
 *    the committed crawl corpus's own last page carries a genuine `null`, untouched.
 */
export function fixtureTransport(fixtures: {
  schedule: unknown | unknown[];
  leagues?: unknown;
  teams?: unknown;
}): RiotRestTransport {
  const size = (v: unknown): number => JSON.stringify(v).length;
  const supply = (name: string, value: unknown) => (): Promise<RawResponse> =>
    value === undefined
      ? Promise.reject(new Error(`no ${name} fixture supplied`))
      : Promise.resolve({ json: value, bytes: size(value) });

  const pages = Array.isArray(fixtures.schedule) ? fixtures.schedule : [fixtures.schedule];
  let nextIndex = 0;
  let expectedToken: string | undefined;

  const getSchedule = (pageToken?: string): Promise<RawResponse> => {
    if (pageToken !== expectedToken) {
      return Promise.reject(
        new Error(
          `fixtureTransport: getSchedule called with pageToken ${JSON.stringify(pageToken)}, ` +
            `expected ${JSON.stringify(expectedToken)} (call ${String(nextIndex + 1)})`,
        ),
      );
    }
    if (nextIndex >= pages.length) {
      return Promise.reject(
        new Error(`fixtureTransport: no page ${String(nextIndex + 1)} supplied; the fixture has ${String(pages.length)}`),
      );
    }
    const doc = JSON.parse(JSON.stringify(pages[nextIndex])) as {
      data?: { schedule?: { pages?: { older: string | null; newer: string | null } } };
    };
    nextIndex += 1;
    const isLast = nextIndex === pages.length;
    const pageBlock = doc.data?.schedule?.pages;
    if (isLast && pageBlock !== undefined) pageBlock.newer = null;
    expectedToken = pageBlock?.newer ?? undefined;
    return Promise.resolve({ json: doc, bytes: size(doc) });
  };

  return {
    getSchedule,
    getLeagues: supply('leagues', fixtures.leagues),
    getTeams: supply('teams', fixtures.teams),
  };
}

const CAPABILITIES: SourceCapabilities = {
  // One schedule endpoint, no scope parameter, returns every league at once.
  scopeDiscovery: 'implicit',
  /**
   * False despite a `state` field existing, because the field is not trustworthy on its own: for
   * matches with an undecided opponent it splits arbitrarily between `completed` and `unstarted`
   * — two matches in the same tournament one day apart disagree. The adapter derives the real
   * value from `result` instead, so the state it reports is inferred, and this flag says so.
   */
  explicitState: false,
  /**
   * True since Stage 0.5, and it describes the *adapter*, not `getSchedule`.
   *
   * getSchedule still contains no team ids — 80 events, 80 ids, none of them a team's. The adapter
   * joins it against `getTeams`, which returns the whole master table with plain numeric ids that
   * match `getEventDetails` and the suffix of the GraphQL composite id. Hiding that second request
   * is the adapter's job (NFR-3); declaring the resulting capability is this flag's.
   *
   * It stays true on a degraded run. A capability is what the adapter can do, not how one fetch
   * went: when getTeams fails, the matches come back with null ids and a `no-team-identity`
   * warning, and mutating the flag instead would make a transient outage look like a redesign.
   */
  teamIdentity: true,
  // Riot supplies no streams at all. Settled; League.defaultStreamUrl is the answer.
  streamUrls: false,
  /**
   * False, and as of Stage 0.7 this is a claim about the adapter's *shape*, not a gap in what has
   * been probed.
   *
   * The cursor parameter is known and used: `pageToken`, base64, decoding to `newer::<snowflake>`
   * or `older::<snowflake>` — verified 2026-08-12 by crawling forward to exhaustion (6 requests,
   * 436 events, terminal `pages.newer === null`; see docs/sources/lolesports-rest.md and
   * fixtures/riot-lol/rest_getSchedule_crawl_2026-08-12/). `fetchMatches` uses it, but to crawl
   * the *whole* forward horizon, not to narrow to one — the opposite of what `timeWindow: true`
   * would mean. The `window` argument is still ignored outright: a forward-only crawl can bound
   * `toUtc` by stopping early, but never `fromUtc` (that needs an `older` crawl, unprobed — see
   * the source note), so honouring half of every window handed to it would overstate the code
   * exactly the way this flag exists to prevent. Flipping it needs a bounded-both-ends crawl, not
   * merely a truncated forward one.
   */
  timeWindow: false,
};

/** The one scope. `implicit`: nothing was enumerated, and no request was spent enumerating it. */
export const GLOBAL_SCOPE: Scope = {
  key: 'global',
  label: 'All LoL leagues',
  discovery: 'implicit',
  activeFrom: null,
  activeUntil: null,
};

const CANARY_WINDOW_DAYS = 14;

/**
 * Why there is no "LCK has >= 1 match in the next 14 days" canary.
 *
 * That was the shape SPEC originally proposed, and it is wrong for a seasonal sport. Measured over
 * the 2026-08-09 capture: the three international majors (`worlds`, `msi`, `first_stand`) have zero
 * matches in the window, which is their normal state for most of the year. Regional leagues have
 * off-seasons and splits breaks too. A forward-looking per-league assertion therefore fires every
 * winter, and a canary that cries wolf on schedule gets muted — after which the next real outage is
 * silent. That is a worse failure than having no canary.
 *
 * So the two assertions below split the job:
 *   1. a covered regional league vanishing from the feed entirely  — a slug break or a rename
 *   2. the feed carrying nothing forward-looking at all            — a stale or empty parse
 *
 * Neither is about HTTP status. Both are about content, which is the whole point (SPEC §4).
 */

/**
 * Every regional league we cover appears somewhere in the fetched window.
 *
 * Presence, not upcoming-ness. `getSchedule` returns a window around now rather than only the
 * future, so a league in a quiet week still shows its recently-played matches. A regional league
 * absent from the whole window means the slug stopped matching — a rename upstream, or a typo in
 * `config/leagues.json` — and a global row count stays perfectly healthy while it happens.
 *
 * International events are excluded by construction: `teamHomeLeagueSlugs()` is the regional subset.
 * Asserting Worlds is present in August would be asserting a false thing.
 */
export function regionalLeaguesPresent(leagueConfig: LeagueConfig): SourceCanary {
  const expected = leagueConfig.teamHomeLeagueSlugs();
  return {
    key: 'regional-leagues-present',
    description: `every covered regional league appears in the feed (${expected.join(', ')})`,
    scopeKey: GLOBAL_SCOPE.key,
    check(matches) {
      const seen = new Set(matches.map((m) => m.leagueSlug));
      const missing = expected.filter((slug) => !seen.has(slug));
      return {
        ok: missing.length === 0,
        detail:
          missing.length === 0
            ? `all ${String(expected.length)} regional leagues present`
            : `absent from the feed: ${missing.join(', ')}`,
      };
    },
  };
}

/**
 * The feed carries at least one match starting in the next 14 days, in any covered league.
 *
 * Deliberately not per-league, so it survives an off-season. What it catches is the failure a status
 * code cannot see: a parse that yields only stale rows, or none at all. Across eight leagues in five
 * regions plus international events, a fortnight with nothing scheduled anywhere does not occur
 * during a season — and if the whole calendar really is dark, that is worth a look regardless.
 */
export const scheduleHasUpcoming: SourceCanary = {
  key: 'schedule-has-upcoming',
  description: `at least one match in the next ${String(CANARY_WINDOW_DAYS)} days`,
  scopeKey: GLOBAL_SCOPE.key,
  check(matches, now) {
    const from = now.getTime();
    const until = addDays(now, CANARY_WINDOW_DAYS).getTime();
    const hits = matches.filter((m) => {
      const at = parseUtcInstant(m.startsAtUtc, 'match.startsAtUtc');
      return at >= from && at <= until;
    });
    return {
      ok: hits.length > 0,
      detail: `${String(hits.length)} match(es) in the next ${String(CANARY_WINDOW_DAYS)} days`,
    };
  },
};

/**
 * Not a time bound — an event bound. 20 pages x 80 events = 1600, ~3.7x the 436 events measured
 * crawling to exhaustion on 2026-08-12. Wide enough that a busier season does not trip it routinely
 * — a cap that always fires trains the reader to ignore `crawl-incomplete`, the same "canary that
 * cries wolf gets muted" failure `scheduleHasUpcoming` above is built around — tight enough that a
 * runaway crawl costs 20 requests, not an unbounded number.
 */
export const MAX_SCHEDULE_PAGES = 20;

type CrawlStopReason = 'exhausted' | 'no-pages-field' | 'repeated-token' | 'page-cap' | 'page-failed';

interface CrawlOutcome {
  pages: RawResponse[];
  complete: boolean;
  stopReason: CrawlStopReason;
  detail: string;
  requestCount: number;
  bytes: number;
}

/** Read just enough of a page to keep crawling — full validation is parseSchedulePages' job, not
 *  this loop's. A page shaped nothing like the envelope reads as `undefined` here and is treated
 *  as `no-pages-field` below; it still gets to the caller and fails loudly in parseSchedulePages. */
function extractPages(json: unknown): { older: string | null; newer: string | null } | undefined {
  const pages = (json as { data?: { schedule?: { pages?: { older: string | null; newer: string | null } } } })
    ?.data?.schedule?.pages;
  return pages;
}

/**
 * Follow `data.schedule.pages.newer` forward until it is null, `maxPages` is reached, or a token
 * repeats. Sequential by construction — page *n+1*'s token comes from page *n* — so no concurrency
 * guard is needed and none is added; 6-ish sequential requests is within the polite-polling budget
 * this project already keeps for its capture tooling (scripts/capture-lib.ts).
 *
 * No added retry, no added sleep. `RiotRestClient.get` already retries 3x with backoff on 5xx/429
 * (client.ts) — wrapping that here would turn one page's failure into 9 attempts instead of 3. A
 * non-429 4xx still fails on the first attempt, unchanged.
 *
 * Nothing at all -> throw (page 1 failing leaves nothing to report, same rule fetchMatches already
 * applies to its old single getSchedule call). Something, but less than usual -> return it and say
 * so; page >= 2 failing still leaves the near-now slice every user-facing surface reads first, and
 * NFR-4 (partial failure isolation) says that slice must not be thrown away to punish the far
 * horizon.
 */
async function crawlSchedule(transport: RiotRestTransport, maxPages: number): Promise<CrawlOutcome> {
  const pages: RawResponse[] = [];
  const sentTokens = new Set<string>();
  let token: string | undefined;
  let requestCount = 0;
  let bytes = 0;

  for (let i = 0; i < maxPages; i++) {
    let res: RawResponse;
    try {
      res = await transport.getSchedule(token);
    } catch (err) {
      if (pages.length === 0) throw err;
      return {
        pages,
        complete: false,
        stopReason: 'page-failed',
        detail: `page ${String(pages.length + 1)} failed, keeping the ${String(pages.length)} already fetched: ${err instanceof Error ? err.message : String(err)}`,
        requestCount,
        bytes,
      };
    }
    requestCount += 1;
    bytes += res.bytes;
    pages.push(res);

    const pageFields = extractPages(res.json);
    if (pageFields === undefined) {
      return {
        pages,
        complete: true,
        stopReason: 'no-pages-field',
        detail: `page ${String(pages.length)} has no pages field; treating it as the only page`,
        requestCount,
        bytes,
      };
    }
    if (pageFields.newer === null) {
      return {
        pages,
        complete: true,
        stopReason: 'exhausted',
        detail: `terminated after ${String(pages.length)} page(s): pages.newer is null`,
        requestCount,
        bytes,
      };
    }
    if (sentTokens.has(pageFields.newer)) {
      return {
        pages,
        complete: false,
        stopReason: 'repeated-token',
        detail: `page ${String(pages.length)} repeated a token already sent; stopping to avoid an infinite crawl`,
        requestCount,
        bytes,
      };
    }
    sentTokens.add(pageFields.newer);
    token = pageFields.newer;
  }

  return {
    pages,
    complete: false,
    stopReason: 'page-cap',
    detail: `stopped at the ${String(maxPages)}-page cap without reaching pages.newer === null`,
    requestCount,
    bytes,
  };
}

/**
 * The tier table is injected rather than read from disk here, for the same reason the transport
 * is: it keeps the adapter free of filesystem access and lets a test state its whole world in
 * three lines instead of maintaining a parallel config file.
 */
export function createRiotRestLolAdapter(
  transport: RiotRestTransport,
  leagueConfig: LeagueConfig,
): SourceAdapter {
  return {
    id: 'riot-rest-lol',
    game: 'lol',
    capabilities: CAPABILITIES,
    canaries: [regionalLeaguesPresent(leagueConfig), scheduleHasUpcoming],

    listScopes(): Promise<FetchResult<Scope>> {
      // No request. The scope is a property of the endpoint, not something discovered from it.
      return Promise.resolve({
        items: [GLOBAL_SCOPE],
        warnings: [],
        diagnostics: { requestCount: 0, bytes: 0 },
      });
    },

    async fetchMatches(_scope: Scope, _window?: TimeWindow): Promise<FetchResult<SourceMatch>> {
      const warn = new WarningCollector();
      let requestCount = 0;
      let bytes = 0;

      /**
       * Primary. Crawls the whole forward horizon (Stage 0.7), not one page — see crawlSchedule.
       * If page 1 fails there is nothing to report, so the error propagates: the sync layer
       * isolates a failed source, an adapter does not fake success. `_window` is intentionally
       * unused; see the `timeWindow` capability comment for why bounding it would be dishonest.
       */
      const crawl = await crawlSchedule(transport, MAX_SCHEDULE_PAGES);
      requestCount += crawl.requestCount;
      bytes += crawl.bytes;
      if (!crawl.complete) {
        warn.warn(
          'crawl-incomplete',
          `schedule crawl stopped early (${crawl.stopReason}): ${crawl.detail}; matches beyond the reached horizon are absent from this fetch and their absence must not be read as cancellation`,
        );
      }

      /**
       * Secondary. getSchedule's `league` object has a slug and a name but no id, so league
       * identity comes from here. When it fails the matches are still returned — every match,
       * with leagueExternalId null — because a calendar missing league ids is far better than a
       * calendar missing matches (NFR-4 applies within a source, not only across sources).
       */
      let leagueIdBySlug: Map<string, string> | undefined;
      let leagueNameBySlug: Map<string, string> | undefined;
      try {
        const leagues = await transport.getLeagues();
        requestCount += 1;
        bytes += leagues.bytes;
        const parsed = parseLeagues(leagues.json, 'lol');
        warn.absorb(parsed.warnings);
        leagueIdBySlug = new Map(parsed.items.map((l) => [l.slug, l.externalId]));
        leagueNameBySlug = new Map(parsed.items.map((l) => [l.slug, l.name]));
      } catch (err) {
        warn.warn(
          'degraded-fetch',
          `getLeagues failed, matches returned without league ids: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      /**
       * Secondary, and the whole point of Stage 0.5. One call per fetch, never one per match.
       *
       * The index needs league *names*, not slugs: getTeams' only handle from a team to a league
       * is `homeLeague.name`, which is localized and carries neither slug nor id. So the config's
       * slugs are translated through getLeagues — and if getLeagues failed there is nothing to
       * translate with, so identity degrades with it rather than silently narrowing to nothing.
       *
       * Note `teamHomeLeagueSlugs()` and not `majorSlugs()`. The two sets differ and conflating
       * them is a bug: getTeams homes seven active rows at Worlds and MSI, none of which is a team
       * that plays — five are 2011-era orgs and two are region placeholders named "LCS" and "VCS",
       * carrying those codes. An international event needs its *matches* resolved; it must never
       * define who the teams are. See src/config/leagues.ts.
       */
      let teamIndex: TeamIndex | undefined;
      if (leagueNameBySlug === undefined) {
        warn.warn(
          'no-team-identity',
          'getLeagues failed, so major league slugs cannot be mapped to the localized names getTeams uses; teams left unidentified',
        );
      } else {
        try {
          const teams = await transport.getTeams();
          requestCount += 1;
          bytes += teams.bytes;
          const parsed = parseTeams(teams.json);
          warn.absorb(parsed.warnings);

          const homeLeagueNames = new Set<string>();
          for (const slug of leagueConfig.teamHomeLeagueSlugs()) {
            const name = leagueNameBySlug.get(slug);
            if (name === undefined) {
              // A slug the config covers that upstream no longer lists. Its teams cannot enter the
              // table, so say so rather than quietly shipping a smaller one.
              warn.warn(
                'scope-list-stale',
                `config/leagues.json covers ${JSON.stringify(slug)} but getLeagues does not list it; its teams are absent from the team table`,
                slug,
              );
              continue;
            }
            homeLeagueNames.add(name);
          }
          teamIndex = buildTeamIndex(parsed.items, homeLeagueNames);
        } catch (err) {
          warn.warn(
            'degraded-fetch',
            `getTeams failed, matches returned without team ids: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      const parsed = parseSchedulePages(
        crawl.pages.map((p) => p.json),
        {
          game: 'lol',
          leagueConfig,
          ...(leagueIdBySlug === undefined ? {} : { leagueIdBySlug }),
          ...(teamIndex === undefined ? {} : { teamIndex }),
        },
      );
      warn.absorb(parsed.warnings);

      const horizonUtc =
        parsed.items.length === 0
          ? null
          : (parsed.items.map((m) => m.startsAtUtc).sort().at(-1) as string);

      return {
        items: parsed.items,
        warnings: warn.list(),
        diagnostics: {
          requestCount,
          bytes,
          teamTableSize: teamIndex?.size ?? 0,
          pagesFetched: crawl.pages.length,
          crawlComplete: crawl.complete,
          horizonUtc,
          duplicateEventsDropped: parsed.duplicateEventsDropped,
        },
      };
    },

    async fetchLeagues(): Promise<FetchResult<SourceLeague>> {
      const res = await transport.getLeagues();
      const parsed = parseLeagues(res.json, 'lol');
      return {
        items: parsed.items,
        warnings: parsed.warnings,
        diagnostics: { requestCount: 1, bytes: res.bytes },
      };
    },

    // No fetchTournaments: getSchedule carries no tournament object for LoL. Method absence is
    // the declaration — there is no capability flag to contradict it.
  };
}
