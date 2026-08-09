/**
 * riot-rest-lol — the first adapter.
 *
 * Riot's REST API is the *secondary* source by design (docs/sources/lolesports-rest.md): the
 * GraphQL endpoint has correct match state and team ids, which this one does not. It is
 * implemented first because it needs only a public static key, whereas GraphQL needs a persisted
 * query hash tied to a frontend build that is recorded nowhere in this repo.
 *
 * Its two known defects are declared, not hidden:
 *   - capabilities.teamIdentity = false     (no team ids anywhere in getSchedule)
 *   - a `lossy-state` warning per affected match (unplayed TBD playoff matches report completed)
 */

import type {
  FetchResult,
  Scope,
  SourceAdapter,
  SourceCanary,
  SourceCapabilities,
  TimeWindow,
} from '../../../core/source.js';
import type { SourceLeague, SourceMatch } from '../../../core/types.js';
import { WarningCollector } from '../../../core/warnings.js';
import { addDays, parseUtcInstant } from '../../../core/time.js';
import { RiotRestClient } from './client.js';
import type { RawResponse } from './client.js';
import { parseLeagues, parseSchedule } from './parse.js';

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
  getSchedule(): Promise<RawResponse>;
  getLeagues(): Promise<RawResponse>;
}

export function httpTransport(client: RiotRestClient): RiotRestTransport {
  return {
    getSchedule: () => client.get('getSchedule'),
    getLeagues: () => client.get('getLeagues'),
  };
}

/** Reads captured responses. Used by the golden-fixture tests and by the CLI's default mode. */
export function fixtureTransport(fixtures: { schedule: unknown; leagues?: unknown }): RiotRestTransport {
  const size = (v: unknown): number => JSON.stringify(v).length;
  return {
    getSchedule: () => Promise.resolve({ json: fixtures.schedule, bytes: size(fixtures.schedule) }),
    getLeagues: () =>
      fixtures.leagues === undefined
        ? Promise.reject(new Error('no leagues fixture supplied'))
        : Promise.resolve({ json: fixtures.leagues, bytes: size(fixtures.leagues) }),
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
  // The disqualifying one: 80 events, 80 ids, none of them a team's.
  teamIdentity: false,
  // Riot supplies no streams at all. Settled; League.defaultStreamUrl is the answer.
  streamUrls: false,
  // getSchedule's `pages` cursors are real and work.
  timeWindow: true,
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
 * The assertion that catches an empty parse.
 *
 * Deliberately about one named league rather than "any matches at all". A global row count stays
 * healthy while LCK alone disappears — which is exactly what a slug typo or an upstream rename
 * produces, and it is invisible to any HTTP-level check.
 */
export const lckHasUpcoming: SourceCanary = {
  key: 'lck-has-upcoming',
  description: `LCK has at least one match in the next ${String(CANARY_WINDOW_DAYS)} days`,
  scopeKey: GLOBAL_SCOPE.key,
  check(matches, now) {
    const until = addDays(now, CANARY_WINDOW_DAYS).getTime();
    const from = now.getTime();
    const hits = matches.filter((m) => {
      if (m.leagueSlug !== 'lck') return false;
      const at = parseUtcInstant(m.startsAtUtc, 'match.startsAtUtc');
      return at >= from && at <= until;
    });
    return {
      ok: hits.length > 0,
      detail: `${String(hits.length)} LCK match(es) in the next ${String(CANARY_WINDOW_DAYS)} days`,
    };
  },
};

export function createRiotRestLolAdapter(transport: RiotRestTransport): SourceAdapter {
  return {
    id: 'riot-rest-lol',
    game: 'lol',
    capabilities: CAPABILITIES,
    canaries: [lckHasUpcoming],

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

      // Primary. If this fails there is nothing to report, so the error propagates: the sync
      // layer isolates a failed source, an adapter does not fake success.
      const schedule = await transport.getSchedule();
      requestCount += 1;
      bytes += schedule.bytes;

      /**
       * Secondary. getSchedule's `league` object has a slug and a name but no id, so league
       * identity comes from here. When it fails the matches are still returned — every match,
       * with leagueExternalId null — because a calendar missing league ids is far better than a
       * calendar missing matches (NFR-4 applies within a source, not only across sources).
       */
      let leagueIdBySlug: Map<string, string> | undefined;
      try {
        const leagues = await transport.getLeagues();
        requestCount += 1;
        bytes += leagues.bytes;
        const parsed = parseLeagues(leagues.json, 'lol');
        warn.absorb(parsed.warnings);
        leagueIdBySlug = new Map(parsed.items.map((l) => [l.slug, l.externalId]));
      } catch (err) {
        warn.warn(
          'degraded-fetch',
          `getLeagues failed, matches returned without league ids: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const parsed = parseSchedule(
        schedule.json,
        leagueIdBySlug === undefined ? { game: 'lol' } : { game: 'lol', leagueIdBySlug },
      );
      warn.absorb(parsed.warnings);

      return { items: parsed.items, warnings: warn.list(), diagnostics: { requestCount, bytes } };
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
