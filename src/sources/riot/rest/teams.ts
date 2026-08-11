/**
 * The team master table, and the code -> team resolution built on it.
 *
 * `getSchedule` names teams but does not identify them. `getTeams` identifies them but says
 * nothing about matches. Joining the two on `code` is what gives this adapter
 * `capabilities.teamIdentity`, and the join is only safe because the candidate set is narrowed
 * first. Measured on the 2026-08-09 capture:
 *
 *   - unnarrowed, over all 1176 active teams, 27 codes are claimed more than once — nearly all of
 *     them a first team and its own Challengers/Academy squad (DK, BFX, HLE, KT, ...)
 *   - narrowed to active teams whose home league is major, 290 rows remain and exactly one code
 *     collides: EG, which is Evil Geniuses LG in LCS and Evil Geniuses EU in LEC. Both are first
 *     teams in major leagues, so no automatic rule separates them and a manual override does
 *
 * Narrowing the table is necessary and **not sufficient**. Resolution is additionally gated on the
 * tier of the league the match is played under, in `resolveTeam`. Without that gate, second-team
 * matches resolve against first-team rows: eleven sides in `rest_getSchedule.json` alone would be
 * given the wrong LCK org's id, and a wrong identity is worse than an absent one.
 *
 * Everything here is Riot vocabulary (`homeLeagueName`, `status`) and none of it leaves this
 * directory. What leaves is a `SourceTeam` with `externalId` populated.
 */

import type { LeagueTier, TeamOverrideDto } from '../../../config/leagues.js';
import type { SourceWarning } from '../../../core/warnings.js';
import { WarningCollector } from '../../../core/warnings.js';
import { GetTeamsResponse } from './dto.js';
import { toHttps } from './https.js';

export interface ParseOutput<T> {
  items: T[];
  warnings: SourceWarning[];
}

/** A row of the master table, in Riot's terms. Internal to this directory. */
export interface RiotTeamRecord {
  externalId: string;
  name: string;
  code: string;
  logoUrl: string | null;
  /** `active` or `archived` in every observed row. Kept as a string; see dto.ts. */
  status: string;
  /**
   * Localized league display name — the only handle getTeams gives from a team to a league. There
   * is no slug and no id here, which is why the caller must translate its major slugs into names
   * via getLeagues before building the index.
   */
  homeLeagueName: string | null;
}

const KNOWN_STATUSES = new Set(['active', 'archived']);

export function parseTeams(raw: unknown): ParseOutput<RiotTeamRecord> {
  const warn = new WarningCollector();
  const envelope = GetTeamsResponse.parse(raw);

  const items = envelope.data.teams.map((t): RiotTeamRecord => {
    if (!KNOWN_STATUSES.has(t.status)) {
      // Warn, never throw and never drop. A status Riot introduced this morning must not empty
      // the team table; an unknown status simply fails the `active` test below.
      warn.warn('unknown-team-status', `unrecognised team status ${JSON.stringify(t.status)}`, t.status);
    }
    return {
      externalId: t.id,
      name: t.name,
      code: t.code,
      logoUrl: toHttps(t.image),
      status: t.status,
      homeLeagueName: t.homeLeague?.name ?? null,
    };
  });

  if (items.length === 0) {
    warn.warn('suspect-empty', 'getTeams returned no teams; team identity would be unavailable');
  }

  return { items, warnings: warn.list() };
}

export interface TeamIndex {
  /** code -> every table row claiming it. More than one entry is a collision, not an error. */
  readonly byCode: ReadonlyMap<string, readonly RiotTeamRecord[]>;
  /** Rows that passed the filter. Not the size of the response. */
  readonly size: number;
}

/**
 * Keep only currently-listed teams whose home league is one we cover.
 *
 * `status: "active"` is emphatically **not** a currency signal — LCK has 70 active rows against
 * ten real teams, because the master table keeps historical orgs listed. That is fine. The table
 * is allowed to be dirty; it is not allowed to collide.
 */
export function buildTeamIndex(
  records: readonly RiotTeamRecord[],
  majorLeagueNames: ReadonlySet<string>,
): TeamIndex {
  const byCode = new Map<string, RiotTeamRecord[]>();
  let size = 0;
  for (const r of records) {
    if (r.status !== 'active') continue;
    if (r.homeLeagueName === null || !majorLeagueNames.has(r.homeLeagueName)) continue;
    size += 1;
    const bucket = byCode.get(r.code);
    if (bucket) bucket.push(r);
    else byCode.set(r.code, [r]);
  }
  return { byCode, size };
}

export type TeamResolution =
  /** The match's league is not one we cover, so no attempt was made. Deliberate, and silent. */
  | { kind: 'out-of-scope' }
  | { kind: 'resolved'; team: RiotTeamRecord }
  /** No row claims this code. */
  | { kind: 'unresolved'; code: string }
  /** Several rows claim it and no override applies. */
  | { kind: 'ambiguous'; code: string; candidates: readonly RiotTeamRecord[] };

export interface ResolveTeamInput {
  code: string;
  /** The slug of the league the match is played under — not the team's home league. */
  leagueSlug: string;
  tier: LeagueTier;
  override: TeamOverrideDto | undefined;
}

/**
 * Pure. No clock, no I/O, no warnings — the caller decides what to say about the outcome, which is
 * what makes this table-testable.
 */
export function resolveTeam(index: TeamIndex, input: ResolveTeamInput): TeamResolution {
  /**
   * The gate that the team table alone cannot provide.
   *
   * A second team plays under its own league slug but carries its parent's code, so a
   * `lck_challengers_league` match asking for "KT" finds `kt Rolster` in a table that quite
   * correctly contains only first teams. Refusing to look is the only correct answer.
   */
  if (input.tier !== 'major') return { kind: 'out-of-scope' };

  const candidates = index.byCode.get(input.code);
  if (candidates === undefined || candidates.length === 0) {
    return { kind: 'unresolved', code: input.code };
  }
  if (candidates.length === 1) {
    const only = candidates[0];
    if (only === undefined) return { kind: 'unresolved', code: input.code };
    return { kind: 'resolved', team: only };
  }

  if (input.override) {
    // The override must name a team that is actually in the table. A stale override pointing at a
    // team that has since been archived is a config bug, and silently honouring it would attach an
    // id nothing else in the system knows about.
    const chosen = candidates.find((c) => c.externalId === input.override?.teamId);
    if (chosen) return { kind: 'resolved', team: chosen };
  }

  return { kind: 'ambiguous', code: input.code, candidates };
}
