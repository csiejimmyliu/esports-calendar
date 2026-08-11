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
import type { LeagueConfig } from '../../../config/leagues.js';
import type { SourceLeague, SourceMatch } from '../../../core/types.js';
import { WarningCollector } from '../../../core/warnings.js';
import { addDays, parseUtcInstant } from '../../../core/time.js';
import { RiotRestClient } from './client.js';
import type { RawResponse } from './client.js';
import { parseLeagues, parseSchedule } from './parse.js';
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
  getSchedule(): Promise<RawResponse>;
  getLeagues(): Promise<RawResponse>;
  /** The team master table. One call per sync run, never one per match. */
  getTeams(): Promise<RawResponse>;
}

export function httpTransport(client: RiotRestClient): RiotRestTransport {
  return {
    getSchedule: () => client.get('getSchedule'),
    getLeagues: () => client.get('getLeagues'),
    getTeams: () => client.get('getTeams'),
  };
}

/** Reads captured responses. Used by the golden-fixture tests and by the CLI's default mode. */
export function fixtureTransport(fixtures: {
  schedule: unknown;
  leagues?: unknown;
  teams?: unknown;
}): RiotRestTransport {
  const size = (v: unknown): number => JSON.stringify(v).length;
  const supply = (name: string, value: unknown) => (): Promise<RawResponse> =>
    value === undefined
      ? Promise.reject(new Error(`no ${name} fixture supplied`))
      : Promise.resolve({ json: value, bytes: size(value) });
  return {
    getSchedule: () => Promise.resolve({ json: fixtures.schedule, bytes: size(fixtures.schedule) }),
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
       * major slugs are translated through getLeagues — and if getLeagues failed there is nothing
       * to translate with, so identity degrades with it rather than silently narrowing to nothing.
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

          const majorNames = new Set<string>();
          for (const slug of leagueConfig.majorSlugs()) {
            const name = leagueNameBySlug.get(slug);
            if (name === undefined) {
              // A slug the config calls major that upstream no longer lists. Its teams cannot
              // enter the table, so say so rather than quietly shipping a smaller one.
              warn.warn(
                'scope-list-stale',
                `config/leagues.json marks ${JSON.stringify(slug)} major but getLeagues does not list it; its teams are absent from the team table`,
                slug,
              );
              continue;
            }
            majorNames.add(name);
          }
          teamIndex = buildTeamIndex(parsed.items, majorNames);
        } catch (err) {
          warn.warn(
            'degraded-fetch',
            `getTeams failed, matches returned without team ids: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      const parsed = parseSchedule(schedule.json, {
        game: 'lol',
        leagueConfig,
        ...(leagueIdBySlug === undefined ? {} : { leagueIdBySlug }),
        ...(teamIndex === undefined ? {} : { teamIndex }),
      });
      warn.absorb(parsed.warnings);

      return {
        items: parsed.items,
        warnings: warn.list(),
        diagnostics: { requestCount, bytes, teamTableSize: teamIndex?.size ?? 0 },
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
