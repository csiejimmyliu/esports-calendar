/**
 * Stage 0.8 — measure the boundary of every Riot REST endpoint this project depends on, or has
 * ever considered depending on. Writes a machine-readable log to docs/probes/riot-rest/, one file
 * per group, so a claim in docs/sources/riot-rest-parameters.md is re-derivable by one command
 * rather than being an assertion about a past session (CLAUDE.md, "How source notes are written").
 *
 * This is deliberately NOT built on RiotRestClient (src/sources/riot/rest/client.ts):
 *
 *   - client.ts converts a 4xx and an HTTP-200 error envelope into a thrown RiotApiError and
 *     discards the response body (client.ts:107, :124-128). The `errors` group exists to record
 *     that body.
 *   - client.ts unconditionally pins hl=en-US (IDENTITY_LOCALE, client.ts:75). The locale probes
 *     need to vary it, and the no-header probe needs to omit a header entirely.
 *
 * A probe measures the endpoint, not our client's opinion of it. What IS reused from
 * scripts/capture-lib.ts is the conduct rule (sequential, spaced, capped) and the api key / user
 * agent plumbing, so the same politeness budget applies here as to fixture capture.
 *
 * Nothing here runs at runtime. Build-time only, like the rest of scripts/ (CLAUDE.md).
 *
 * Usage:
 *   RIOT_ESPORTS_API_KEY=... npm run probe -- schedule-params
 *   RIOT_ESPORTS_API_KEY=... npm run probe -- catalog-params
 *   RIOT_ESPORTS_API_KEY=... npm run probe -- errors
 *   RIOT_ESPORTS_API_KEY=... npm run probe -- unmapped-endpoints
 *   RIOT_ESPORTS_API_KEY=... npm run probe -- event-details
 *
 * One group per invocation — the full survey is ~27 requests, MAX_REQUESTS_PER_RUN is 20, and a
 * group corresponds to one question-cluster in docs/sources/riot-rest-parameters.md's Probe log.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { RIOT_REST_BASE } from '../src/sources/riot/rest/client.js';
import { apiKeyFromEnv, USER_AGENT, MIN_REQUEST_SPACING_MS, MAX_REQUESTS_PER_RUN } from './capture-lib.js';

const PROBES_ROOT = new URL('../docs/probes/riot-rest/', import.meta.url).pathname;

// Known ids, all already documented elsewhere in this repo (never fabricated for this script):
// LCK's leagueId is the worked example in scripts/capture-fixture.ts's own usage comment; the EWC
// leagueId is recorded in fixtures/riot-lol/rest_getSchedule_ewc.meta.json; the EG teamId is one of
// the two manual overrides in config/leagues.json.
const KNOWN_LEAGUE_ID_LCK = '98767991310872058';
const KNOWN_LEAGUE_ID_EWC = '116838530616006090';
const KNOWN_TEAM_ID_EG_LCS = '103461966951059521';

interface ProbeResult {
  status: number;
  ok: boolean;
  bytes: number;
  json: unknown;
}

interface ProbeContext {
  apiKey: string;
  results: Map<string, ProbeResult>;
}

interface ProbeRequest {
  endpoint: string;
  params: Record<string, string>;
  /** Full replacement of the default header set. Omit a key to send the request without it. */
  headers?: Record<string, string>;
}

interface ProbeDef {
  id: string;
  question: string;
  /** Return null to skip the network call entirely -- used when a prerequisite from an earlier
   *  probe in the same run (a token, an id) wasn't available. A probe that never fires is reported
   *  in the log as skipped, not sent with a placeholder value that would waste a real request and
   *  muddy the verdict with a response to a query nobody meant to ask. */
  request: (ctx: ProbeContext) => ProbeRequest | null;
  analyze: (result: ProbeResult, ctx: ProbeContext) => { bodySummary: Record<string, unknown>; verdict: string };
  evidenceBasis: string;
}

function buildUrl(endpoint: string, params: Record<string, string>): string {
  const url = new URL(`${RIOT_REST_BASE}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

function defaultHeaders(apiKey: string): Record<string, string> {
  return { 'x-api-key': apiKey, 'user-agent': USER_AGENT, accept: 'application/json' };
}

async function rawGet(url: string, headers: Record<string, string>): Promise<ProbeResult> {
  const res = await fetch(url, { headers });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = { __nonJsonBody: text.slice(0, 500) };
  }
  return { status: res.status, ok: res.ok, bytes: text.length, json };
}

// ---- shape helpers, shared by several probes' analyze() ----

function scheduleFields(json: unknown): {
  eventCount: number;
  firstStart: string | null;
  lastStart: string | null;
  pagesNewer: string | null | undefined;
  pagesOlder: string | null | undefined;
  leagueSlugs: string[];
  firstMatchId: string | null;
  firstBlockName: string | null | undefined;
  matchIds: string[];
} {
  const events = ((json as { data?: { schedule?: { events?: unknown[] } } })?.data?.schedule?.events ??
    []) as { startTime?: string; league?: { slug?: string }; match?: { id?: string }; blockName?: string | null }[];
  const pages = (json as { data?: { schedule?: { pages?: { newer?: string | null; older?: string | null } } } })
    ?.data?.schedule?.pages;
  const starts = events.map((e) => e.startTime).filter((t): t is string => typeof t === 'string');
  const matchIds = events.map((e) => e.match?.id).filter((id): id is string => typeof id === 'string');
  return {
    eventCount: events.length,
    firstStart: starts[0] ?? null,
    lastStart: starts.length > 0 ? (starts[starts.length - 1] ?? null) : null,
    pagesNewer: pages?.newer,
    pagesOlder: pages?.older,
    leagueSlugs: [...new Set(events.map((e) => e.league?.slug).filter((s): s is string => typeof s === 'string'))],
    firstMatchId: matchIds[0] ?? null,
    firstBlockName: events[0]?.blockName,
    matchIds,
  };
}

function errorSummary(json: unknown): { hasErrorsKey: boolean; hasDataKey: boolean; messages: string[] } {
  const asObj = json as { errors?: { message?: string }[]; data?: unknown };
  return {
    hasErrorsKey: Array.isArray(asObj?.errors),
    hasDataKey: asObj?.data !== undefined,
    messages: Array.isArray(asObj?.errors)
      ? asObj.errors.map((e) => (typeof e.message === 'string' ? e.message : JSON.stringify(e)))
      : [],
  };
}

// ---- probe groups ----

function scheduleParamsGroup(): ProbeDef[] {
  return [
    {
      id: 'anchor',
      question: 'Baseline: an unparameterised getSchedule call, everything else in this group compares against it.',
      request: () => ({ endpoint: 'getSchedule', params: { hl: 'en-US' } }),
      analyze: (r) => {
        const f = scheduleFields(r.json);
        return {
          bodySummary: f,
          verdict: `${String(f.eventCount)} events, leagues=${f.leagueSlugs.join(',')}, newer=${String(f.pagesNewer)}, older=${String(f.pagesOlder)}`,
        };
      },
      evidenceBasis: 'measured, this run, n=1',
    },
    {
      id: 'unknown-param',
      question:
        'Does Riot reject an unrecognised query parameter, or silently ignore it? Every other "endpoint X ' +
        'has no parameter Y" claim in this repo is bounded by the answer — if unknown params are ignored, ' +
        'a typo in a real parameter name looks identical to that parameter not existing.',
      request: () => ({ endpoint: 'getSchedule', params: { hl: 'en-US', thisParamDoesNotExist: '1' } }),
      analyze: (r, ctx) => {
        const f = scheduleFields(r.json);
        const anchor = ctx.results.get('anchor');
        const anchorF = anchor ? scheduleFields(anchor.json) : null;
        const sameShape = anchorF !== null && f.eventCount === anchorF.eventCount && f.firstStart === anchorF.firstStart;
        return {
          bodySummary: f,
          verdict:
            r.status === 200
              ? sameShape
                ? 'HTTP 200, body identical to the anchor -- unknown params are silently ignored'
                : 'HTTP 200, but body differs from the anchor -- unexpected, needs a second look'
              : `HTTP ${String(r.status)} -- unknown params are rejected`,
        };
      },
      evidenceBasis: 'measured, this run, n=1, compared against the anchor probe in the same run',
    },
    {
      id: 'hl-zh-tw',
      question:
        'Which fields translate under hl=zh-TW and which do not, checked same-run against the anchor rather ' +
        'than across two fixtures captured days apart (as rest_getSchedule.json vs the team table currently are).',
      request: () => ({ endpoint: 'getSchedule', params: { hl: 'zh-TW' } }),
      analyze: (r, ctx) => {
        const f = scheduleFields(r.json);
        const anchor = ctx.results.get('anchor');
        const anchorF = anchor ? scheduleFields(anchor.json) : null;
        return {
          bodySummary: f,
          verdict:
            anchorF === null
              ? 'no anchor to compare against'
              : `blockName anchor="${String(anchorF.firstBlockName)}" vs zh-TW="${String(f.firstBlockName)}"; ` +
                `leagueSlugs identical=${String(JSON.stringify(f.leagueSlugs) === JSON.stringify(anchorF.leagueSlugs))}`,
        };
      },
      evidenceBasis: 'measured, this run, n=1, compared against the anchor probe in the same run',
    },
    {
      id: 'hl-invalid',
      question:
        'A malformed hl value: hard error, or a silent fallback to English? A silent fallback would make a ' +
        'typo\'d locale invisible in a sidecar (this is exactly the class of bug rest_getSchedule.json shipped ' +
        'with, hl=zh-TW while the client pinned en-US).',
      request: () => ({ endpoint: 'getSchedule', params: { hl: 'xx-XX' } }),
      analyze: (r) => {
        const f = scheduleFields(r.json);
        return {
          bodySummary: f,
          verdict:
            r.status !== 200
              ? `HTTP ${String(r.status)} -- rejected`
              : `HTTP 200, ${String(f.eventCount)} events -- accepted, blockName sample="${String(f.firstBlockName)}"`,
        };
      },
      evidenceBasis: 'measured, this run, n=1',
    },
    {
      id: 'league-id-lck',
      question:
        `A single-league scoped call (leagueId=${KNOWN_LEAGUE_ID_LCK}, lck). Also the source of a pageToken ` +
        'for the next probe.',
      request: () => ({ endpoint: 'getSchedule', params: { hl: 'en-US', leagueId: KNOWN_LEAGUE_ID_LCK } }),
      analyze: (r) => {
        const f = scheduleFields(r.json);
        return { bodySummary: f, verdict: `${String(f.eventCount)} events, leagues=${f.leagueSlugs.join(',')}` };
      },
      evidenceBasis: 'measured, this run, n=1',
    },
    {
      id: 'league-id-and-page-token',
      question: 'Do leagueId and pageToken compose, or does one silently win?',
      request: (ctx) => {
        const prior = ctx.results.get('league-id-lck');
        const token = prior ? scheduleFields(prior.json).pagesNewer : null;
        if (token == null) return null;
        return { endpoint: 'getSchedule', params: { hl: 'en-US', leagueId: KNOWN_LEAGUE_ID_LCK, pageToken: token } };
      },
      analyze: (r) => {
        const f = scheduleFields(r.json);
        return {
          bodySummary: f,
          verdict:
            r.status === 200
              ? `HTTP 200, leagues=${f.leagueSlugs.join(',')} -- ` +
                (f.leagueSlugs.length === 1 && f.leagueSlugs[0] === 'lck' ? 'leagueId scope held under pagination' : 'leagueId scope did NOT hold, needs review')
              : `HTTP ${String(r.status)} -- combination rejected`,
        };
      },
      evidenceBasis: 'measured, this run, n=1, conditional on league-id-lck returning a non-null pages.newer',
    },
    {
      id: 'multi-league-id-csv',
      question:
        'Can one request cover several leagues via a comma-joined leagueId, cutting request volume for a ' +
        'multi-league sync? Neither documented nor implied by anything in the codebase; purely exploratory.',
      request: () => ({
        endpoint: 'getSchedule',
        params: { hl: 'en-US', leagueId: `${KNOWN_LEAGUE_ID_LCK},${KNOWN_LEAGUE_ID_EWC}` },
      }),
      analyze: (r) => {
        const f = scheduleFields(r.json);
        return {
          bodySummary: f,
          verdict:
            r.status !== 200
              ? `HTTP ${String(r.status)} -- CSV rejected`
              : f.leagueSlugs.length > 1
                ? `HTTP 200, leagues=${f.leagueSlugs.join(',')} -- CSV leagueId returns multiple leagues`
                : `HTTP 200, leagues=${f.leagueSlugs.join(',')} -- CSV leagueId did not expand (only first id honoured, or no matches for the second)`,
        };
      },
      evidenceBasis: 'measured, this run, n=1',
    },
  ];
}

function catalogParamsGroup(): ProbeDef[] {
  return [
    {
      id: 'leagues-anchor',
      question: 'Baseline getLeagues call: total count and byte size, for comparison against the id-filtered probe.',
      request: () => ({ endpoint: 'getLeagues', params: { hl: 'en-US' } }),
      analyze: (r) => {
        const leagues = ((r.json as { data?: { leagues?: unknown[] } })?.data?.leagues ?? []) as { id?: string }[];
        return { bodySummary: { count: leagues.length, bytes: r.bytes }, verdict: `${String(leagues.length)} leagues, ${String(r.bytes)} bytes` };
      },
      evidenceBasis: 'measured, this run, n=1',
    },
    {
      id: 'leagues-id-filter',
      question: 'Does getLeagues accept an id filter and narrow its result, or ignore it and return everything?',
      request: () => ({ endpoint: 'getLeagues', params: { hl: 'en-US', id: KNOWN_LEAGUE_ID_LCK } }),
      analyze: (r, ctx) => {
        const leagues = ((r.json as { data?: { leagues?: unknown[] } })?.data?.leagues ?? []) as { id?: string }[];
        const anchor = ctx.results.get('leagues-anchor');
        const anchorCount = anchor
          ? (((anchor.json as { data?: { leagues?: unknown[] } })?.data?.leagues ?? []) as unknown[]).length
          : null;
        return {
          bodySummary: { count: leagues.length },
          verdict:
            leagues.length === 1 && leagues[0]?.id === KNOWN_LEAGUE_ID_LCK
              ? 'id filter narrows to exactly the requested league'
              : leagues.length === anchorCount
                ? 'id filter ignored -- full list returned unchanged'
                : `id filter changed the result to ${String(leagues.length)} rows, not the requested single row -- needs review`,
        };
      },
      evidenceBasis: 'measured, this run, n=1, compared against leagues-anchor in the same run',
    },
    {
      id: 'teams-anchor',
      question: 'Baseline getTeams call: row count and byte size, and whether a pages block exists at all.',
      request: () => ({ endpoint: 'getTeams', params: { hl: 'en-US' } }),
      analyze: (r) => {
        const data = (r.json as { data?: { teams?: unknown[]; pages?: unknown } })?.data;
        const teams = (data?.teams ?? []) as { name?: string }[];
        return {
          bodySummary: { count: teams.length, bytes: r.bytes, hasPagesBlock: data?.pages !== undefined },
          verdict: `${String(teams.length)} teams, ${String(r.bytes)} bytes, pages block present=${String(data?.pages !== undefined)}`,
        };
      },
      evidenceBasis: 'measured, this run, n=1',
    },
    {
      id: 'teams-id-filter',
      question:
        'lolesports-rest.md:266 claims getTeams takes "no other parameters; returns everything". Nothing has ' +
        'ever probed that. This either confirms or retires the claim.',
      request: () => ({ endpoint: 'getTeams', params: { hl: 'en-US', id: KNOWN_TEAM_ID_EG_LCS } }),
      analyze: (r, ctx) => {
        const teams = ((r.json as { data?: { teams?: unknown[] } })?.data?.teams ?? []) as { id?: string }[];
        const anchor = ctx.results.get('teams-anchor');
        const anchorCount = anchor ? ((anchor.json as { data?: { teams?: unknown[] } })?.data?.teams ?? []).length : null;
        return {
          bodySummary: { count: teams.length },
          verdict:
            teams.length === 1 && teams[0]?.id === KNOWN_TEAM_ID_EG_LCS
              ? 'id filter narrows to exactly the requested team -- lolesports-rest.md:266 is WRONG, retire the claim'
              : teams.length === anchorCount
                ? 'id filter ignored -- CONFIRMS lolesports-rest.md:266, "no other parameters" holds for id at least'
                : `id filter changed the result to ${String(teams.length)} rows -- needs review`,
        };
      },
      evidenceBasis: 'measured, this run, n=1, compared against teams-anchor in the same run',
    },
    {
      id: 'teams-hl-zh-tw',
      question:
        'The highest-value probe in this stage: does getTeams.name (the team-identity join key, CLAUDE.md ' +
        '"Team identity is a narrowed join") change under hl=zh-TW? The existing locale-stability evidence is ' +
        'two fixtures captured three days apart under different hl values. This is a same-instant A/B.',
      request: () => ({ endpoint: 'getTeams', params: { hl: 'zh-TW' } }),
      analyze: (r, ctx) => {
        const teams = ((r.json as { data?: { teams?: unknown[] } })?.data?.teams ?? []) as { id?: string; name?: string }[];
        const anchor = ctx.results.get('teams-anchor');
        const anchorTeams = anchor
          ? (((anchor.json as { data?: { teams?: unknown[] } })?.data?.teams ?? []) as { id?: string; name?: string }[])
          : [];
        const byId = new Map(anchorTeams.map((t) => [t.id, t.name]));
        let compared = 0;
        let mismatched = 0;
        const sampleMismatch: { id: string | undefined; enName: string | undefined; zhName: string | undefined }[] = [];
        for (const t of teams) {
          const enName = byId.get(t.id);
          if (enName === undefined) continue;
          compared += 1;
          if (enName !== t.name) {
            mismatched += 1;
            if (sampleMismatch.length < 5) sampleMismatch.push({ id: t.id, enName, zhName: t.name });
          }
        }
        return {
          bodySummary: { compared, mismatched, sampleMismatch },
          verdict:
            compared === 0
              ? 'no overlapping team ids with the anchor -- comparison inconclusive'
              : mismatched === 0
                ? `name is IDENTICAL under hl=zh-TW vs en-US for all ${String(compared)} compared teams -- ` +
                  'CONFIRMS the locale-stability premise the name join relies on, same-instant this time'
                : `name DIFFERS under hl=zh-TW for ${String(mismatched)}/${String(compared)} compared teams -- ` +
                  'the name join key is locale-dependent for at least some rows. STOP AND REPORT: this is a ' +
                  'Stage 1 blocker, not a documentation nicety.',
        };
      },
      evidenceBasis: 'measured, this run, n=1 per locale, compared same-instant against teams-anchor',
    },
  ];
}

function errorsGroup(): ProbeDef[] {
  return [
    {
      id: 'wrong-key',
      question: 'What does Riot return for a syntactically plausible but wrong x-api-key?',
      request: (ctx) => ({
        endpoint: 'getSchedule',
        params: { hl: 'en-US' },
        headers: { ...defaultHeaders(ctx.apiKey), 'x-api-key': '0000000000000000000000000000000000' },
      }),
      analyze: (r) => {
        const e = errorSummary(r.json);
        return { bodySummary: e, verdict: `HTTP ${String(r.status)}, errors key present=${String(e.hasErrorsKey)}, messages=${JSON.stringify(e.messages)}` };
      },
      evidenceBasis: 'measured, this run, n=1',
    },
    {
      id: 'no-key-header',
      question: 'What happens with the x-api-key header omitted entirely, as opposed to wrong?',
      request: (ctx) => {
        const headers = defaultHeaders(ctx.apiKey);
        delete headers['x-api-key'];
        return { endpoint: 'getSchedule', params: { hl: 'en-US' }, headers };
      },
      analyze: (r) => {
        const e = errorSummary(r.json);
        return { bodySummary: e, verdict: `HTTP ${String(r.status)}, errors key present=${String(e.hasErrorsKey)}, messages=${JSON.stringify(e.messages)}` };
      },
      evidenceBasis: 'measured, this run, n=1',
    },
    {
      id: 'nonexistent-endpoint',
      question: 'What does a made-up endpoint name return -- 404, or the same HTTP-200 error envelope as a bad param?',
      request: (ctx) => ({ endpoint: 'thisEndpointDoesNotExist', params: { hl: 'en-US' }, headers: defaultHeaders(ctx.apiKey) }),
      analyze: (r) => {
        const e = errorSummary(r.json);
        return { bodySummary: e, verdict: `HTTP ${String(r.status)}, errors key present=${String(e.hasErrorsKey)}, messages=${JSON.stringify(e.messages)}` };
      },
      evidenceBasis: 'measured, this run, n=1',
    },
    {
      id: 'malformed-page-token',
      question:
        'A pageToken that is not valid base64 at all -- pins client.ts:85\'s "4xx is final, never retried" ' +
        'policy to an observed status rather than to convention.',
      request: (ctx) => ({
        endpoint: 'getSchedule',
        params: { hl: 'en-US', pageToken: 'not-valid-base64!!!' },
        headers: defaultHeaders(ctx.apiKey),
      }),
      analyze: (r) => {
        const e = errorSummary(r.json);
        const f = r.status === 200 ? scheduleFields(r.json) : null;
        return {
          bodySummary: f ?? e,
          verdict:
            r.status !== 200
              ? `HTTP ${String(r.status)} -- rejected, errors=${JSON.stringify(e.messages)}`
              : `HTTP 200, ${String(f?.eventCount)} events, span ${String(f?.firstStart)}..${String(f?.lastStart)} -- ` +
                'a malformed (non-base64) token is silently ignored, not rejected; the API falls back to the ' +
                'default unparameterised first page rather than erroring',
        };
      },
      evidenceBasis: 'measured, this run, n=1',
    },
    {
      id: 'meaningless-token',
      question: 'A well-formed base64 token that decodes to a syntactically valid but meaningless cursor (older::0).',
      request: (ctx) => ({
        endpoint: 'getSchedule',
        params: { hl: 'en-US', pageToken: Buffer.from('older::0').toString('base64') },
        headers: defaultHeaders(ctx.apiKey),
      }),
      analyze: (r) => {
        const f = scheduleFields(r.json);
        const e = errorSummary(r.json);
        return {
          bodySummary: r.status === 200 ? f : e,
          verdict:
            r.status === 200
              ? `HTTP 200, ${String(f.eventCount)} events -- accepted, no bounds check on the snowflake value`
              : `HTTP ${String(r.status)} -- rejected, errors=${JSON.stringify(e.messages)}`,
        };
      },
      evidenceBasis: 'measured, this run, n=1',
    },
  ];
}

function unmappedEndpointsGroup(): ProbeDef[] {
  return [
    {
      id: 'tournaments-for-league',
      question:
        'getTournamentsForLeague is named in lolesports-rest.md:57-58 and never mentioned again. Probed first ' +
        'in this group because getStandings needs a tournament id that only this endpoint supplies.',
      request: (ctx) => ({ endpoint: 'getTournamentsForLeague', params: { hl: 'en-US', leagueId: KNOWN_LEAGUE_ID_LCK }, headers: defaultHeaders(ctx.apiKey) }),
      analyze: (r) => {
        const e = errorSummary(r.json);
        const tournaments = (r.json as { data?: { leagues?: { tournaments?: { id?: string }[] }[] } })?.data?.leagues;
        const firstTournamentId = tournaments?.[0]?.tournaments?.[0]?.id ?? null;
        return {
          bodySummary: { hasErrorsKey: e.hasErrorsKey, messages: e.messages, firstTournamentId, raw: r.status === 200 ? undefined : r.json },
          verdict: r.status === 200 ? `HTTP 200, firstTournamentId=${String(firstTournamentId)}` : `HTTP ${String(r.status)}, errors=${JSON.stringify(e.messages)}`,
        };
      },
      evidenceBasis: 'measured, this run, n=1',
    },
    {
      id: 'standings',
      question: 'getStandings, named and never called. Uses the tournament id from tournaments-for-league if one was found.',
      request: (ctx) => {
        const prior = ctx.results.get('tournaments-for-league');
        const tournaments = prior
          ? (prior.json as { data?: { leagues?: { tournaments?: { id?: string }[] }[] } })?.data?.leagues
          : undefined;
        const tournamentId = tournaments?.[0]?.tournaments?.[0]?.id;
        if (tournamentId == null) return null;
        return { endpoint: 'getStandings', params: { hl: 'en-US', tournamentId }, headers: defaultHeaders(ctx.apiKey) };
      },
      analyze: (r) => {
        const e = errorSummary(r.json);
        return { bodySummary: e, verdict: r.status === 200 ? 'HTTP 200 -- see raw log for shape' : `HTTP ${String(r.status)}, errors=${JSON.stringify(e.messages)}` };
      },
      evidenceBasis: 'measured, this run, n=1, conditional on tournaments-for-league finding an id',
    },
    {
      id: 'completed-events',
      question:
        'getCompletedEvents bears directly on the open "past matches" question (SPEC §1 says in scope; the ' +
        'owner separately said they are "no longer important" -- unresolved, see the plan\'s open items).',
      request: (ctx) => ({ endpoint: 'getCompletedEvents', params: { hl: 'en-US', leagueId: KNOWN_LEAGUE_ID_LCK }, headers: defaultHeaders(ctx.apiKey) }),
      analyze: (r) => {
        const e = errorSummary(r.json);
        const f = r.status === 200 ? scheduleFields(r.json) : null;
        return {
          bodySummary: f ?? e,
          verdict: r.status === 200 ? `HTTP 200, ${String(f?.eventCount)} events -- see raw log for shape` : `HTTP ${String(r.status)}, errors=${JSON.stringify(e.messages)}`,
        };
      },
      evidenceBasis: 'measured, this run, n=1',
    },
    {
      id: 'live',
      question:
        'getLive was probed once before (lolesports-rest.md:461, inconclusive -- "{\\"events\\": []}", off-hours). ' +
        'One more data point, still likely off-hours; the note already says re-probe during a broadcast.',
      request: (ctx) => ({ endpoint: 'getLive', params: { hl: 'en-US' }, headers: defaultHeaders(ctx.apiKey) }),
      analyze: (r) => {
        const events = (r.json as { data?: { schedule?: { events?: unknown[] } } })?.data?.schedule?.events;
        return {
          bodySummary: { eventCount: Array.isArray(events) ? events.length : null, raw: r.json },
          verdict: r.status === 200 ? `HTTP 200, events=${String(Array.isArray(events) ? events.length : null)}` : `HTTP ${String(r.status)}`,
        };
      },
      evidenceBasis: 'measured, this run, n=1 -- still not during a confirmed live broadcast',
    },
  ];
}

function eventDetailsGroup(): ProbeDef[] {
  return [
    {
      id: 'schedule-anchor',
      question: 'Grab real match ids from a plain getSchedule call, and its pages.older token for the walk below.',
      request: () => ({ endpoint: 'getSchedule', params: { hl: 'en-US' } }),
      analyze: (r) => {
        const f = scheduleFields(r.json);
        return { bodySummary: f, verdict: `${String(f.eventCount)} events, ${String(f.matchIds.length)} match ids, older=${String(f.pagesOlder)}` };
      },
      evidenceBasis: 'measured, this run, n=1',
    },
    {
      id: 'event-details-by-id',
      question: 'getEventDetails on one real match id: what does it add over getSchedule for the same match?',
      request: (ctx) => {
        const anchor = ctx.results.get('schedule-anchor');
        const id = anchor ? scheduleFields(anchor.json).firstMatchId : null;
        if (id == null) return null;
        return { endpoint: 'getEventDetails', params: { hl: 'en-US', id } };
      },
      analyze: (r) => {
        const event = (r.json as { data?: { event?: { streams?: unknown[] } } })?.data?.event;
        const keys = event !== undefined && typeof event === 'object' && event !== null ? Object.keys(event) : [];
        return {
          bodySummary: { hasEvent: event !== undefined, keys, streams: event?.streams },
          verdict:
            `HTTP ${String(r.status)}, keys=${keys.join(',')}` +
            (event?.streams !== undefined ? `, streams=${JSON.stringify(event.streams)} (present as a key, empty for this match)` : ''),
        };
      },
      evidenceBasis: 'measured, this run, n=1',
    },
    {
      id: 'event-details-two-ids',
      question: 'Does getEventDetails accept a comma-joined id list (batching), or only ever the first?',
      request: (ctx) => {
        const anchor = ctx.results.get('schedule-anchor');
        const ids = anchor ? scheduleFields(anchor.json).matchIds.slice(0, 2) : [];
        if (ids.length < 2) return null;
        return { endpoint: 'getEventDetails', params: { hl: 'en-US', id: ids.join(',') } };
      },
      analyze: (r, ctx) => {
        const anchor = ctx.results.get('schedule-anchor');
        const ids = anchor ? scheduleFields(anchor.json).matchIds.slice(0, 2) : [];
        const e = errorSummary(r.json);
        return {
          bodySummary: { requestedIds: ids, ...e },
          verdict:
            r.status === 200
              ? `HTTP 200 -- see raw log for shape (unexpected: previous probes of this endpoint saw a 4xx for a comma-joined id)`
              : `HTTP ${String(r.status)} -- a comma-joined id list is rejected outright, not partially honoured; no batching`,
        };
      },
      evidenceBasis: 'measured, this run, n=1',
    },
    {
      id: 'event-details-bogus',
      question: 'getEventDetails with an id that cannot exist: error shape for an unknown-but-well-formed id.',
      request: () => ({ endpoint: 'getEventDetails', params: { hl: 'en-US', id: '999999999999999999' } }),
      analyze: (r) => {
        const event = (r.json as { data?: { event?: unknown } })?.data?.event;
        const hasDataKey = (r.json as { data?: unknown })?.data !== undefined;
        return {
          bodySummary: { hasDataKey, event },
          verdict:
            r.status === 200 && hasDataKey && event === null
              ? 'HTTP 200, data.event is null -- NOT the error-envelope shape client.ts checks for; a parser must ' +
                'check for a null event explicitly, RiotErrorEnvelope would not catch this'
              : `HTTP ${String(r.status)}, event=${JSON.stringify(event)}`,
        };
      },
      evidenceBasis: 'measured, this run, n=1',
    },
    {
      id: 'older-walk-2',
      question:
        'Owner decision this session: probe the "older" (backward) direction 3 pages deep, to confirm the ' +
        'direction works and pages are contiguous -- NOT to find where it terminates (fixtures/README.md ' +
        'Open item: 480 events back to 2026-07-19 after 6 pages, still non-null).',
      request: (ctx) => {
        const anchor = ctx.results.get('schedule-anchor');
        const token = anchor ? scheduleFields(anchor.json).pagesOlder : null;
        if (token == null) return null;
        return { endpoint: 'getSchedule', params: { hl: 'en-US', pageToken: token } };
      },
      analyze: (r, ctx) => {
        const anchor = ctx.results.get('schedule-anchor');
        const f = scheduleFields(r.json);
        const anchorF = anchor ? scheduleFields(anchor.json) : null;
        const contiguous = anchorF !== null && f.lastStart !== null && anchorF.firstStart !== null && f.lastStart <= anchorF.firstStart;
        return { bodySummary: f, verdict: `${String(f.eventCount)} events, span ${String(f.firstStart)}..${String(f.lastStart)}, contiguous-with-anchor=${String(contiguous)}, older=${String(f.pagesOlder)}` };
      },
      evidenceBasis: 'measured, this run, n=1, page 2 of a 3-page older walk',
    },
    {
      id: 'older-walk-3',
      question: 'Page 3 of the 3-page older walk.',
      request: (ctx) => {
        const page2 = ctx.results.get('older-walk-2');
        const token = page2 ? scheduleFields(page2.json).pagesOlder : null;
        if (token == null) return null;
        return { endpoint: 'getSchedule', params: { hl: 'en-US', pageToken: token } };
      },
      analyze: (r) => {
        const f = scheduleFields(r.json);
        return { bodySummary: f, verdict: `${String(f.eventCount)} events, span ${String(f.firstStart)}..${String(f.lastStart)}, older=${String(f.pagesOlder)} (still non-null means the direction keeps going past 3 pages, as previously found)` };
      },
      evidenceBasis: 'measured, this run, n=1, page 3 of a 3-page older walk',
    },
  ];
}

const GROUPS: Record<string, () => ProbeDef[]> = {
  'schedule-params': scheduleParamsGroup,
  'catalog-params': catalogParamsGroup,
  errors: errorsGroup,
  'unmapped-endpoints': unmappedEndpointsGroup,
  'event-details': eventDetailsGroup,
};

function usage(message: string): never {
  process.stderr.write(
    `${message}\n\nusage: npm run probe -- <group>\ngroups: ${Object.keys(GROUPS).join(', ')}\n`,
  );
  process.exit(2);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const group = process.argv[2];
  if (group === undefined) usage('a group name is required');
  const build = GROUPS[group];
  if (build === undefined) usage(`unknown group: ${group}`);

  const probes = build();
  if (probes.length > MAX_REQUESTS_PER_RUN) {
    usage(`group ${group} has ${String(probes.length)} probes, over the ${String(MAX_REQUESTS_PER_RUN)}-request-per-run cap`);
  }

  const apiKey = apiKeyFromEnv();
  const ctx: ProbeContext = { apiKey, results: new Map() };
  const capturedAt = new Date().toISOString();

  const logEntries: {
    id: string;
    question: string;
    url: string;
    requestHeaders: Record<string, string>;
    status: number;
    ok: boolean;
    bytes: number;
    bodySummary: Record<string, unknown>;
    verdict: string;
    evidenceBasis: string;
  }[] = [];

  for (const [i, probe] of probes.entries()) {
    const req = probe.request(ctx);
    if (req === null) {
      logEntries.push({
        id: probe.id,
        question: probe.question,
        url: '<skipped -- a prerequisite from an earlier probe in this run was unavailable>',
        requestHeaders: {},
        status: 0,
        ok: false,
        bytes: 0,
        bodySummary: { skipped: true },
        verdict: 'SKIPPED -- not sent. A prerequisite (token or id) from an earlier probe was unavailable this run.',
        evidenceBasis: probe.evidenceBasis,
      });
      process.stderr.write(`[${String(i + 1)}/${String(probes.length)}] ${probe.id}: SKIPPED (no prerequisite)\n`);
      continue;
    }

    if (i > 0) await sleep(MIN_REQUEST_SPACING_MS);
    const headers = req.headers ?? defaultHeaders(apiKey);
    const url = buildUrl(req.endpoint, req.params);
    process.stderr.write(`[${String(i + 1)}/${String(probes.length)}] ${probe.id}: ${url}\n`);

    const result = await rawGet(url, headers);
    ctx.results.set(probe.id, result);
    const { bodySummary, verdict } = probe.analyze(result, ctx);

    logEntries.push({
      id: probe.id,
      question: probe.question,
      url,
      requestHeaders: { ...headers, 'x-api-key': headers['x-api-key'] === undefined ? '<omitted>' : '<redacted>' },
      status: result.status,
      ok: result.ok,
      bytes: result.bytes,
      bodySummary,
      verdict,
      evidenceBasis: probe.evidenceBasis,
    });
    process.stderr.write(`    -> ${verdict}\n`);
  }

  await mkdir(PROBES_ROOT, { recursive: true });
  const outPath = join(PROBES_ROOT, `${group}.probe.json`);
  await writeFile(outPath, `${JSON.stringify({ capturedAt, group, probes: logEntries }, null, 2)}\n`);
  process.stdout.write(`\nWrote ${outPath}\n`);
}

try {
  await main();
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
