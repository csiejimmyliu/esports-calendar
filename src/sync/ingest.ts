/**
 * Idempotent sync: fetch from one adapter, upsert into Postgres, never touch user tables.
 *
 * Idempotency is not "running it twice happens not to duplicate rows" — it is `resolveOrCreate`
 * (src/sync/crosswalk.ts) making every write either "this external id has never been seen, create
 * it" or "this external id already resolves to canonical id X, update X's fields", with no third
 * path that could invent a second row for the same source-and-external-id pair.
 *
 * Stage 1a ran the whole source as one transaction; Stage 1b splits it (see `withTransaction`
 * below and its callers) so that a broken scope, or a broken `fetchLeagues`, cannot roll back
 * matches a healthy scope already committed. The trade-off is explicit: this drops whole-run
 * atomicity in exchange for the SPEC-mandated "a deliberately broken source does not fail the
 * run". `ensureGame`/`ensureSource` still run first and alone — if those fail, nothing else in
 * this source could possibly succeed either, so there is nothing to isolate.
 *
 * NFR-8 ("a user's explicit selection is never overwritten by sync") is enforced by absence: this
 * file contains no reference to `selection`, `follow`, or `app_user`. `tests/db/sync-ingest.test.ts`
 * exercises this behaviourally (sync leaves a hand-placed `selection`/`follow` row byte-identical);
 * it cannot assert the absence itself, since a test cannot inspect this file's imports.
 */

import type { Pool, PoolClient } from 'pg';

import type { LeagueConfig } from '../config/leagues.js';
import type { Scope, SourceAdapter } from '../core/source.js';
import type { SourceMatch } from '../core/types.js';
import type { SourceWarning } from '../core/warnings.js';
import { detectCancellations } from './cancellation.js';
import { resolveOrCreate } from './crosswalk.js';
import type { MatchSnapshot } from './diff.js';
import { visibleChange } from './diff.js';
import type { SourceRegistryEntry } from './registry.js';

import { ensureGame, ensureSource } from '../db/queries/registry.js';
import { insertLeague, updateLeagueFields } from '../db/queries/leagues.js';
import type { LeagueFields } from '../db/queries/leagues.js';
import { insertTeam, updateTeamFields } from '../db/queries/teams.js';
import type { TeamFields } from '../db/queries/teams.js';
import {
  getMatchById,
  getMatchTeams,
  insertMatch,
  listKnownMatches,
  markCancelled,
  updateMatch,
  upsertMatchTeam,
} from '../db/queries/matches.js';
import type { MatchFields } from '../db/queries/matches.js';
import { finishSyncRun, insertCanaryResult, recordSourceHealth, startSyncRun } from '../db/queries/health.js';
import type { SyncRunStatus } from '../db/queries/health.js';

export interface ScopeFailure {
  scopeKey: string;
  message: string;
}

export interface CanaryOutcome {
  key: string;
  scopeKey: string;
  ok: boolean;
  detail: string;
}

export interface SyncReport {
  sourceId: string;
  scopesProcessed: number;
  scopesFailed: number;
  scopeFailures: ScopeFailure[];
  /** Set only when the source could not even be enumerated (`listScopes` itself threw, or the
   *  registry rows themselves could not be written) — no scope was attempted. Distinct from
   *  `scopeFailures`, where enumeration worked and individual scopes failed independently. */
  fatal: string | null;
  matchesFetched: number;
  leaguesUpserted: number;
  teamsUpserted: number;
  matchesInserted: number;
  matchesUpdated: number;
  matchesUnchanged: number;
  matchesCancelled: number;
  warnings: SourceWarning[];
  canaryResults: CanaryOutcome[];
}

/**
 * `ok` — every scope processed, every canary passed. `degraded` — some data was ingested but a
 * scope failed or a canary did not pass; a wrong-looking calendar beats no calendar, so this never
 * blocks the run, only marks it. `failed` — nothing was ingested at all (fatal, or every scope
 * failed). Read by `recordSourceHealth`/`finishSyncRun` below, and by `src/cli/sync.ts`'s exit code.
 */
export function classifyRun(report: SyncReport): Exclude<SyncRunStatus, 'running'> {
  if (report.fatal !== null) return 'failed';
  if (report.scopesProcessed === 0 && report.scopesFailed > 0) return 'failed';
  if (report.scopesFailed > 0) return 'degraded';
  if (report.canaryResults.some((c) => !c.ok)) return 'degraded';
  return 'ok';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** One BEGIN/COMMIT per call, ROLLBACK on throw. Never nested — see the file header for why the
 *  run is split into several of these rather than one. */
async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function leagueKindFor(leagueConfig: LeagueConfig, slug: string): 'region' | 'event' | null {
  if (leagueConfig.tierFor(slug) !== 'major') return null;
  return leagueConfig.teamHomeLeagueSlugs().includes(slug) ? 'region' : 'event';
}

/** Resolves (or creates) the league a match was played under, from its slug — the only handle
 *  `getSchedule` reliably carries even when `fetchLeagues` degraded (SourceMatch.leagueExternalId
 *  can be null; leagueSlug is not, per the DTO). Returns null only when the match itself has no
 *  league at all, which no current adapter produces but the type allows. */
async function resolveLeague(
  client: PoolClient,
  entry: SourceRegistryEntry,
  leagueConfig: LeagueConfig,
  externalId: string,
  slug: string,
  name: string,
  region: string | null,
  logoUrl: string | null,
): Promise<string> {
  const tier = leagueConfig.tierFor(slug);
  const fields: LeagueFields = { slug, name, region, logoUrl, tier, kind: leagueKindFor(leagueConfig, slug) };
  const cw = await resolveOrCreate(client, 'league', entry.source.id, entry.game.id, externalId, () =>
    insertLeague(client, entry.game.id, fields),
  );
  if (!cw.isNew) await updateLeagueFields(client, cw.entityId, fields);
  return cw.entityId;
}

async function upsertMatchAndSides(
  client: PoolClient,
  entry: SourceRegistryEntry,
  leagueConfig: LeagueConfig,
  sm: SourceMatch,
  leagueIdBySlug: Map<string, string>,
): Promise<{ inserted: boolean; updated: boolean; teamsTouched: number }> {
  let leagueId: string | null = null;
  if (sm.leagueSlug !== null) {
    const cached = leagueIdBySlug.get(sm.leagueSlug);
    if (cached !== undefined) {
      leagueId = cached;
    } else if (sm.leagueExternalId !== null) {
      // fetchLeagues degraded or the slug wasn't in its result; fall back to a minimal row keyed
      // on the id the match itself carries, rather than losing the match's league entirely.
      leagueId = await resolveLeague(
        client,
        entry,
        leagueConfig,
        sm.leagueExternalId,
        sm.leagueSlug,
        sm.leagueSlug,
        null,
        null,
      );
      leagueIdBySlug.set(sm.leagueSlug, leagueId);
    }
  }

  const sideTeamIds: [string | null, string | null] = [null, null];
  // A named side whose identity did not resolve (degraded getTeams, team-unresolved,
  // team-ambiguous) is not the same thing as a genuine TBD — `side.team === null` is TBD,
  // `side.team !== null && side.team.externalId === null` is "we don't know who this is right
  // now". Writing null for the latter would let a transient upstream outage erase an identity
  // this project already resolved. Marked here; the update branch below substitutes the stored
  // value instead of overwriting it, and a brand-new match (nothing stored yet) simply has none
  // to fall back to.
  const sideUnresolved: [boolean, boolean] = [false, false];
  const sideScores: [number | null, number | null] = [null, null];
  let teamsTouched = 0;
  for (const i of [0, 1] as const) {
    const side = sm.sides[i];
    sideScores[i] = side.score;
    if (side.team === null) continue; // genuine TBD: sideTeamIds[i] stays null
    if (side.team.externalId === null) {
      sideUnresolved[i] = true;
      continue;
    }
    const fields: TeamFields = { name: side.team.name, code: side.team.code, logoUrl: side.team.logoUrl };
    const cw = await resolveOrCreate(client, 'team', entry.source.id, entry.game.id, side.team.externalId, () =>
      insertTeam(client, entry.game.id, fields),
    );
    if (!cw.isNew) await updateTeamFields(client, cw.entityId, fields);
    sideTeamIds[i] = cw.entityId;
    teamsTouched += 1;
  }

  const matchFields: MatchFields = {
    tournamentId: null, // getSchedule carries no tournament for LoL (see parse.ts)
    leagueId,
    startsAtUtc: sm.startsAtUtc,
    bestOf: sm.seriesLength,
    gamesPlayed: sm.gamesPlayed,
    blockName: sm.stageLabel,
    state: sm.state,
  };

  const cw = await resolveOrCreate(client, 'match', entry.source.id, entry.game.id, sm.externalId, () =>
    insertMatch(client, matchFields),
  );

  let updated = false;
  if (cw.isNew) {
    // Nothing stored yet to preserve; an unresolved side on a brand-new match has no team_id to
    // fall back to, so it is written as null, exactly like a genuine TBD.
    for (const i of [0, 1] as const) await upsertMatchTeam(client, cw.entityId, i, sideTeamIds[i], sideScores[i]);
  } else {
    const existing = await getMatchById(client, cw.entityId);
    if (existing === null) {
      throw new Error(`external_ref points match ${sm.externalId} at ${cw.entityId}, which no longer exists`);
    }
    const existingSides = await getMatchTeams(client, cw.entityId);
    // An unresolved side keeps whatever this match already had, both for the write and for the
    // diff — so a transient identity outage neither loses the team nor bumps revision.
    const effectiveSideTeamIds: [string | null, string | null] = [
      sideUnresolved[0] ? existingSides[0] : sideTeamIds[0],
      sideUnresolved[1] ? existingSides[1] : sideTeamIds[1],
    ];
    const incoming: MatchSnapshot = {
      startsAtUtc: matchFields.startsAtUtc,
      state: matchFields.state,
      seriesLength: matchFields.bestOf,
      stageLabel: matchFields.blockName,
      sideTeamIds: effectiveSideTeamIds,
    };
    const before: MatchSnapshot = {
      startsAtUtc: existing.startsAtUtc,
      state: existing.state,
      seriesLength: existing.bestOf,
      stageLabel: existing.blockName,
      sideTeamIds: existingSides,
    };
    const bump = visibleChange(before, incoming);
    await updateMatch(client, cw.entityId, matchFields, bump);
    for (const i of [0, 1] as const)
      await upsertMatchTeam(client, cw.entityId, i, effectiveSideTeamIds[i], sideScores[i]);
    updated = bump;
  }

  return { inserted: cw.isNew, updated, teamsTouched };
}

interface ScopeSyncOutcome {
  matchesFetched: number;
  teamsUpserted: number;
  matchesInserted: number;
  matchesUpdated: number;
  matchesUnchanged: number;
  matchesCancelled: number;
  warnings: SourceWarning[];
  canaryResults: CanaryOutcome[];
  /** League ids resolved by the per-match fallback in `upsertMatchAndSides` (a slug fetchLeagues
   *  did not supply), new this scope. Merged into the shared `leagueIdBySlug` cache by the caller
   *  only once this scope's transaction has actually committed — see the caller for why. */
  newLeagueIdsBySlug: Map<string, string>;
}

/**
 * Returns its own outcome rather than mutating a shared report, so a caller only merges it into
 * `SyncReport` once the transaction wrapping this call has actually committed — merging first and
 * rolling back the DB write underneath it would leave the report claiming work that never landed.
 */
async function syncScope(
  client: PoolClient,
  entry: SourceRegistryEntry,
  adapter: SourceAdapter,
  leagueConfig: LeagueConfig,
  scope: Scope,
  leagueIdBySlug: ReadonlyMap<string, string>,
  now: Date,
): Promise<ScopeSyncOutcome> {
  const outcome: ScopeSyncOutcome = {
    matchesFetched: 0,
    teamsUpserted: 0,
    matchesInserted: 0,
    matchesUpdated: 0,
    matchesUnchanged: 0,
    matchesCancelled: 0,
    warnings: [],
    canaryResults: [],
    newLeagueIdsBySlug: new Map(),
  };

  // A local copy, not the shared cache itself: the per-match fallback below (inside
  // upsertMatchAndSides) writes into this as it resolves new slugs, but this scope's transaction
  // can still roll back after some of those writes have happened — a scope failing partway must
  // not leave a later, healthy scope reading a league id whose INSERT never committed. Only
  // `outcome.newLeagueIdsBySlug` (returned once this function is done, merged by the caller only
  // after the transaction that produced it has actually committed) is allowed to reach the shared
  // cache — same pattern already used for the fetchLeagues merge in `runSyncBody`.
  const scopedLeagueIdBySlug = new Map(leagueIdBySlug);

  const result = await adapter.fetchMatches(scope);
  outcome.warnings.push(...result.warnings);
  outcome.matchesFetched += result.items.length;

  // Scheduling, not invention — `regionalLeaguesPresent` and `scheduleHasUpcoming`
  // (src/sources/riot/rest/adapter.ts) already exist and are unit-tested for off-season
  // quietness. This is Stage 1b's job: run them against this scope's fetch and persist the
  // verdict, never re-derive their content assertions.
  for (const canary of adapter.canaries) {
    if (canary.scopeKey !== scope.key) continue;
    const verdict = canary.check(result.items, now);
    outcome.canaryResults.push({ key: canary.key, scopeKey: scope.key, ok: verdict.ok, detail: verdict.detail });
  }

  let fromUtc: string | null = null;
  let toUtc: string | null = null;

  for (const sm of result.items) {
    if (fromUtc === null || sm.startsAtUtc < fromUtc) fromUtc = sm.startsAtUtc;
    if (toUtc === null || sm.startsAtUtc > toUtc) toUtc = sm.startsAtUtc;

    const { inserted, updated, teamsTouched } = await upsertMatchAndSides(
      client,
      entry,
      leagueConfig,
      sm,
      scopedLeagueIdBySlug,
    );
    outcome.teamsUpserted += teamsTouched;
    if (inserted) outcome.matchesInserted += 1;
    else if (updated) outcome.matchesUpdated += 1;
    else outcome.matchesUnchanged += 1;
  }

  for (const [slug, id] of scopedLeagueIdBySlug) {
    if (!leagueIdBySlug.has(slug)) outcome.newLeagueIdsBySlug.set(slug, id);
  }

  if (fromUtc !== null && toUtc !== null) {
    // Which ids this fetch actually saw, not which ones survived parsing — those are not the same
    // set (Stage 1b, `FetchResult.observed`). Falls back to `items`' own ids when an adapter has
    // not adopted `observed` yet, i.e. today's pre-1b behaviour.
    const fetchedExternalIds = result.observed?.externalIds ?? new Set(result.items.map((m) => m.externalId));

    // `crawlComplete` is riot-rest-lol's own diagnostic vocabulary (src/sources/riot/rest/adapter.ts),
    // read generically here since FetchDiagnostics is an open bag by design (NFR-3: the sync layer
    // must not need source-specific knowledge to function, only to interpret this one flag when
    // present). Its absence defaults to "not complete", the safe direction — no adapter's silence
    // about its own completeness should ever cause a cancellation. A nonzero `unidentifiedDrops`
    // is the same kind of "this fetch is not a complete picture" signal and forces the same
    // conclusion: a parser regression must never read as a wave of cancellations.
    const complete = result.diagnostics['crawlComplete'] === true && (result.observed?.unidentifiedDrops ?? 0) === 0;
    const known = await listKnownMatches(client, entry.source.id, entry.game.id);
    const toCancel = detectCancellations(
      known.map((k) => ({ externalId: k.externalId, startsAtUtc: k.startsAtUtc })),
      fetchedExternalIds,
      { fromUtc, toUtc, complete },
    );
    const byExternalId = new Map(known.map((k) => [k.externalId, k.matchId]));
    for (const externalId of toCancel) {
      const matchId = byExternalId.get(externalId);
      if (matchId === undefined) continue;
      const cancelled = await markCancelled(client, matchId);
      if (cancelled) outcome.matchesCancelled += 1;
    }
  }

  return outcome;
}

/**
 * `now` drives the canaries (`SourceCanary.check`), never the data — every timestamp on a stored
 * match still comes from the fetch itself. Required rather than defaulted to the wall clock, same
 * reasoning as `src/cli/next-matches.ts`'s `--now`: a fixture-backed test run must never silently
 * read `Date.now()`.
 *
 * Never throws. `report.fatal` / `scopeFailures` are how a caller learns something went wrong —
 * see the file header for why: a source failure must not prevent `source_health`/`sync_run` from
 * being recorded, and CLAUDE.md's "a deliberately broken source does not fail the run" applies to
 * the process, not only to the data.
 */
export async function runSync(
  pool: Pool,
  entry: SourceRegistryEntry,
  adapter: SourceAdapter,
  leagueConfig: LeagueConfig,
  now: Date,
): Promise<SyncReport> {
  const report: SyncReport = {
    sourceId: entry.source.id,
    scopesProcessed: 0,
    scopesFailed: 0,
    scopeFailures: [],
    fatal: null,
    matchesFetched: 0,
    leaguesUpserted: 0,
    teamsUpserted: 0,
    matchesInserted: 0,
    matchesUpdated: 0,
    matchesUnchanged: 0,
    matchesCancelled: 0,
    warnings: [],
    canaryResults: [],
  };

  // `sync_run`/`source_health` both carry an FK to `source(id)`, so the registry rows have to
  // exist before either can be written — and if they cannot be written at all, there is no valid
  // source_id to record against, so this really is the one case with nothing to isolate and
  // nothing to record: return early rather than attempt a health write that would itself fail.
  try {
    await withTransaction(pool, async (client) => {
      await ensureGame(client, entry.game);
      await ensureSource(client, entry.source);
    });
  } catch (err) {
    report.fatal = errorMessage(err);
    return report;
  }

  const runId = await startSyncRun(pool, entry.source.id);

  try {
    await runSyncBody(pool, entry, adapter, leagueConfig, now, report);
  } catch (err) {
    // Nothing below this point isolates itself further than "per scope" — see the file header.
    // Reaching here means something outside any single scope's transaction went wrong (a fetchLeagues
    // write that isn't the try/catch'd fetch itself, or `listScopes` — already handled inside
    // runSyncBody and returns instead of throwing — or a genuinely unexpected bug). Recorded, not
    // left to crash the process, same reasoning as a broken scope.
    report.fatal = errorMessage(err);
  }

  const status = classifyRun(report);
  const warningCount = report.warnings.reduce((sum, w) => sum + w.count, 0);
  const detail =
    report.fatal ??
    (report.scopeFailures.length > 0 ? report.scopeFailures.map((f) => `${f.scopeKey}: ${f.message}`).join('; ') : null);
  await finishSyncRun(pool, runId, status, report.matchesFetched, warningCount, detail);
  await recordSourceHealth(pool, entry.source.id, status !== 'failed', report.matchesFetched, status);
  for (const c of report.canaryResults) {
    await insertCanaryResult(pool, entry.source.id, c.key, c.ok, c.detail);
  }

  return report;
}

async function runSyncBody(
  pool: Pool,
  entry: SourceRegistryEntry,
  adapter: SourceAdapter,
  leagueConfig: LeagueConfig,
  now: Date,
  report: SyncReport,
): Promise<void> {
  // ensureGame/ensureSource already ran in `runSync`, before the sync_run record was opened —
  // sync_run.source_id/source_health.source_id both carry an FK to source(id), so those rows have
  // to exist first. See the file header for the isolation rationale.
  const leagueIdBySlug = new Map<string, string>();
  if (adapter.fetchLeagues) {
    try {
      const leaguesResult = await adapter.fetchLeagues();
      report.warnings.push(...leaguesResult.warnings);
      const resolved = await withTransaction(pool, async (client) => {
        const ids = new Map<string, string>();
        for (const sl of leaguesResult.items) {
          const id = await resolveLeague(client, entry, leagueConfig, sl.externalId, sl.slug, sl.name, sl.region, sl.logoUrl);
          ids.set(sl.slug, id);
        }
        return ids;
      });
      for (const [slug, id] of resolved) leagueIdBySlug.set(slug, id);
      report.leaguesUpserted += resolved.size;
    } catch (err) {
      // A calendar missing league ids is far better than a calendar missing matches — the same
      // rule the adapter itself already applies to a degraded getLeagues (adapter.ts:431-436).
      // The per-match fallback in `upsertMatchAndSides` (leagueExternalId + leagueSlug) covers
      // this: `leagueIdBySlug` simply stays empty and every match resolves its own league row.
      report.warnings.push({
        code: 'degraded-fetch',
        message: `fetchLeagues failed, matches will be ingested without league ids: ${errorMessage(err)}`,
        count: 1,
      });
    }
  }

  let scopes: Scope[] = [];
  try {
    const scopesResult = await adapter.listScopes();
    report.warnings.push(...scopesResult.warnings);
    scopes = scopesResult.items;
  } catch (err) {
    report.fatal = `listScopes failed: ${errorMessage(err)}`;
    return;
  }

  for (const scope of scopes) {
    try {
      const outcome = await withTransaction(pool, (client) =>
        syncScope(client, entry, adapter, leagueConfig, scope, leagueIdBySlug, now),
      );
      report.scopesProcessed += 1;
      report.matchesFetched += outcome.matchesFetched;
      report.teamsUpserted += outcome.teamsUpserted;
      report.matchesInserted += outcome.matchesInserted;
      report.matchesUpdated += outcome.matchesUpdated;
      report.matchesUnchanged += outcome.matchesUnchanged;
      report.matchesCancelled += outcome.matchesCancelled;
      report.warnings.push(...outcome.warnings);
      report.canaryResults.push(...outcome.canaryResults);
      // Only now, after this scope's transaction has actually committed, do its fallback-resolved
      // league ids become visible to the next scope. See ScopeSyncOutcome.newLeagueIdsBySlug.
      for (const [slug, id] of outcome.newLeagueIdsBySlug) leagueIdBySlug.set(slug, id);
    } catch (err) {
      // One broken scope must not roll back a healthy sibling's already-committed matches, and
      // must not stop the loop — the next scope gets its own chance.
      report.scopesFailed += 1;
      report.scopeFailures.push({ scopeKey: scope.key, message: errorMessage(err) });
    }
  }
}
