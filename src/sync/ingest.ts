/**
 * Idempotent sync: fetch from one adapter, upsert into Postgres, never touch user tables.
 *
 * The whole run is one transaction. Idempotency is not "running it twice happens not to
 * duplicate rows" — it is `resolveOrCreate` (src/sync/crosswalk.ts) making every write either
 * "this external id has never been seen, create it" or "this external id already resolves to
 * canonical id X, update X's fields", with no third path that could invent a second row for the
 * same source-and-external-id pair.
 *
 * NFR-8 ("a user's explicit selection is never overwritten by sync") is enforced by absence: this
 * file contains no reference to `selection`, `follow`, or `app_user`. tests/db/sync-ingest.test.ts
 * asserts that, rather than trusting the absence to hold.
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

export interface SyncReport {
  sourceId: string;
  scopesProcessed: number;
  matchesFetched: number;
  leaguesUpserted: number;
  teamsUpserted: number;
  matchesInserted: number;
  matchesUpdated: number;
  matchesUnchanged: number;
  matchesCancelled: number;
  warnings: SourceWarning[];
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
  const sideScores: [number | null, number | null] = [null, null];
  let teamsTouched = 0;
  for (const i of [0, 1] as const) {
    const side = sm.sides[i];
    sideScores[i] = side.score;
    if (side.team === null || side.team.externalId === null) continue; // TBD or unresolved: no crosswalk row
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
    for (const i of [0, 1] as const) await upsertMatchTeam(client, cw.entityId, i, sideTeamIds[i], sideScores[i]);
  } else {
    const existing = await getMatchById(client, cw.entityId);
    if (existing === null) {
      throw new Error(`external_ref points match ${sm.externalId} at ${cw.entityId}, which no longer exists`);
    }
    const existingSides = await getMatchTeams(client, cw.entityId);
    const incoming: MatchSnapshot = {
      startsAtUtc: matchFields.startsAtUtc,
      state: matchFields.state,
      seriesLength: matchFields.bestOf,
      stageLabel: matchFields.blockName,
      sideTeamIds,
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
    for (const i of [0, 1] as const) await upsertMatchTeam(client, cw.entityId, i, sideTeamIds[i], sideScores[i]);
    updated = bump;
  }

  return { inserted: cw.isNew, updated, teamsTouched };
}

async function syncScope(
  client: PoolClient,
  entry: SourceRegistryEntry,
  adapter: SourceAdapter,
  leagueConfig: LeagueConfig,
  scope: Scope,
  leagueIdBySlug: Map<string, string>,
  report: SyncReport,
): Promise<void> {
  const result = await adapter.fetchMatches(scope);
  report.warnings.push(...result.warnings);
  report.matchesFetched += result.items.length;

  const fetchedExternalIds = new Set<string>();
  let fromUtc: string | null = null;
  let toUtc: string | null = null;

  for (const sm of result.items) {
    fetchedExternalIds.add(sm.externalId);
    if (fromUtc === null || sm.startsAtUtc < fromUtc) fromUtc = sm.startsAtUtc;
    if (toUtc === null || sm.startsAtUtc > toUtc) toUtc = sm.startsAtUtc;

    const { inserted, updated, teamsTouched } = await upsertMatchAndSides(client, entry, leagueConfig, sm, leagueIdBySlug);
    report.teamsUpserted += teamsTouched;
    if (inserted) report.matchesInserted += 1;
    else if (updated) report.matchesUpdated += 1;
    else report.matchesUnchanged += 1;
  }

  if (fromUtc !== null && toUtc !== null) {
    // `crawlComplete` is riot-rest-lol's own diagnostic vocabulary (src/sources/riot/rest/adapter.ts),
    // read generically here since FetchDiagnostics is an open bag by design (NFR-3: the sync layer
    // must not need source-specific knowledge to function, only to interpret this one flag when
    // present). Its absence defaults to "not complete", the safe direction — no adapter's silence
    // about its own completeness should ever cause a cancellation.
    const complete = result.diagnostics['crawlComplete'] === true;
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
      await markCancelled(client, matchId);
      report.matchesCancelled += 1;
    }
  }
}

export async function runSync(
  pool: Pool,
  entry: SourceRegistryEntry,
  adapter: SourceAdapter,
  leagueConfig: LeagueConfig,
): Promise<SyncReport> {
  const client = await pool.connect();
  const report: SyncReport = {
    sourceId: entry.source.id,
    scopesProcessed: 0,
    matchesFetched: 0,
    leaguesUpserted: 0,
    teamsUpserted: 0,
    matchesInserted: 0,
    matchesUpdated: 0,
    matchesUnchanged: 0,
    matchesCancelled: 0,
    warnings: [],
  };

  try {
    await client.query('BEGIN');
    await ensureGame(client, entry.game);
    await ensureSource(client, entry.source);

    const leagueIdBySlug = new Map<string, string>();
    if (adapter.fetchLeagues) {
      const leaguesResult = await adapter.fetchLeagues();
      report.warnings.push(...leaguesResult.warnings);
      for (const sl of leaguesResult.items) {
        const id = await resolveLeague(
          client,
          entry,
          leagueConfig,
          sl.externalId,
          sl.slug,
          sl.name,
          sl.region,
          sl.logoUrl,
        );
        leagueIdBySlug.set(sl.slug, id);
        report.leaguesUpserted += 1;
      }
    }

    const scopesResult = await adapter.listScopes();
    report.warnings.push(...scopesResult.warnings);
    for (const scope of scopesResult.items) {
      await syncScope(client, entry, adapter, leagueConfig, scope, leagueIdBySlug, report);
      report.scopesProcessed += 1;
    }

    await client.query('COMMIT');
    return report;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
