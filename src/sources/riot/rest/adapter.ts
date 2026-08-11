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
  /**
   * False, and this is about the adapter rather than the endpoint — and also about a gap in what
   * has actually been probed, not only about what the adapter has chosen to skip.
   *
   * `fetchMatches` sends no cursor and ignores its `window` argument entirely, so declaring `true`
   * would be a lie the sync layer branches on: it would request a range and silently receive
   * everything. That much is a settled fact about this code.
   *
   * What is NOT settled: `data.schedule.pages.{older,newer}` do carry non-null base64 cursors on
   * an unparameterised `getSchedule` call (verified — see fixtures/riot-lol/rest_getSchedule.json)
   * and are both null on the `leagueId`-scoped capture used for `rest_getSchedule_ewc.json`, which
   * is consistent with that call returning a single page rather than with pagination working end
   * to end. **The query parameter name to send a cursor back has never been recorded or probed
   * anywhere in this repo** — an earlier draft of this comment said the cursors "actually work",
   * which overstated a field being present and non-null into a claim about a request nobody has
   * made. See docs/sources/lolesports-rest.md for the same correction. Historical backfill (SPEC:
   * past schedule must be browsable) is the change that flips this flag, and the first step is
   * probing that parameter name, not implementing against a guess.
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
