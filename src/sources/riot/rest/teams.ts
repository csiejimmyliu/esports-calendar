/**
 * The team master table, and the code -> team resolution built on it.
 *
 * `getSchedule` names teams but does not identify them. `getTeams` identifies them but says nothing
 * about matches. Joining the two is what gives this adapter `capabilities.teamIdentity`.
 *
 * **The join key is `name`, with `code` as a fallback.** That is a change from the original design,
 * which used `code` alone plus two layers of narrowing to compensate. The earlier note dismissed both
 * fields together as "unstable" and never measured them against each other. Measured against the full
 * 1568-row capture of 2026-08-09 (1176 active), under the eight-league coverage of 2026-08-11:
 *
 *   | candidate set                                  | by name              | by code              |
 *   |------------------------------------------------|----------------------|----------------------|
 *   | all 1176 active rows                           | 15 collisions        | 46 collisions        |
 *   | narrowed to covered regional leagues (168)     | **0 collisions**     | 1 collision (EG)     |
 *   | the 60 covered sides in rest_getSchedule.json  | 60 unique, 0 missed  | 60 unique, 0 missed  |
 *
 * The decisive difference is not the collision count, it is *which* collisions. **A code identifies
 * the organisation, not the squad**, so all seven LCK orgs that field an academy team share a code
 * between the two — and none of them share a name:
 *
 *   KT  -> "kt Rolster" / "kt Challengers"        DK  -> "Dplus KIA" / "DK Challengers"
 *   HLE -> "Hanwha Life Esports" / "HLE Chall."   BFX -> "BNK FEARX" / "BNK FEARX Youth"
 *   NS  -> "NONGSHIM RED FORCE" / "NS Chall."     KRX -> "KIWOOM DRX" / "KRX Challengers"
 *   DNS -> "DN SOOPers" / "DNS Challengers"
 *
 * Under a code join, an academy side resolves to its parent — a wrong identity that looks exactly
 * like a right one, and the reason the tier gate had to exist. Under a name join the academy is
 * simply absent from a narrowed table, so the lookup misses and says so. Safety by construction
 * rather than by a guard.
 *
 * Names are also locale-stable, which is the one thing that could have killed this: the schedule
 * fixture was captured under `hl=zh-TW` and the team table under `hl=en-US`, and all 60 names matched
 * byte for byte. `blockName` and `region` *are* translated; team names are not.
 *
 * `code` is kept as a fallback for the case a name has been renamed in one endpoint and not the
 * other, and a fallback hit raises `team-name-mismatch` — right answer, early warning.
 *
 * Narrowing still matters, and the narrowing set is `teamHomeLeagueSlugs()`, not `majorSlugs()`.
 * Including the three international majors would add seven rows and take the index to 175: five
 * 2011-era orgs plus two region placeholders *named* "LCS" and "VCS" that carry those codes. See
 * config/leagues.ts.
 *
 * The figures above are measured against a response that is **not in version control** (1.5 MB, see
 * fixtures/riot-lol/rest_getTeams.meta.json for how to re-capture it). The committed fixture is
 * trimmed to 71 rows and cannot reproduce them, so the tests assert what the trimmed fixture can
 * actually support and this comment is labelled rather than trusted.
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

/**
 * Normalized lookup key for a team name.
 *
 * Trimmed because six active rows carry trailing whitespace (`"Suning "`, `"TT willhaben "`,
 * `"Esport Academy "`, …) and an exact-match join would miss them. Lower-cased because a casing
 * difference between two endpoints of the same source is a nuisance rather than a signal.
 *
 * Measured over the full 1568-row capture: trimming and lower-casing introduces **zero** additional
 * collisions, so the forgiveness costs no precision.
 */
export function normalizeTeamName(name: string): string {
  return name.trim().toLowerCase();
}

export interface TeamIndex {
  /**
   * Normalized name -> every table row claiming it. This is the **primary** join key.
   *
   * Measured over the full 1568-row capture: 15 name collisions among all 1176 active rows against
   * 46 for `code`, and **zero** name collisions once narrowed to covered regional leagues against
   * one for `code` (EG). Names also separate a parent from its own academy, which codes do not —
   * see the header comment.
   */
  readonly byName: ReadonlyMap<string, readonly RiotTeamRecord[]>;
  /** code -> every table row claiming it. The fallback. More than one entry is a collision. */
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
  homeLeagueNames: ReadonlySet<string>,
): TeamIndex {
  const byName = new Map<string, RiotTeamRecord[]>();
  const byCode = new Map<string, RiotTeamRecord[]>();
  let size = 0;
  for (const r of records) {
    if (r.status !== 'active') continue;
    if (r.homeLeagueName === null || !homeLeagueNames.has(r.homeLeagueName)) continue;
    size += 1;
    const push = (m: Map<string, RiotTeamRecord[]>, k: string): void => {
      const bucket = m.get(k);
      if (bucket) bucket.push(r);
      else m.set(k, [r]);
    };
    push(byName, normalizeTeamName(r.name));
    push(byCode, r.code);
  }
  return { byName, byCode, size };
}

export type TeamResolution =
  /** The match's league is not one we cover, so no attempt was made. Deliberate, and silent. */
  | { kind: 'out-of-scope' }
  /**
   * `matchedBy` is not decoration. `'code'` means the two endpoints disagreed on this team's name,
   * which is the early symptom of a rename that has propagated to one endpoint and not the other.
   * The caller warns on it: the identity is still right, but the disagreement is worth knowing about
   * before it becomes a miss.
   */
  | { kind: 'resolved'; team: RiotTeamRecord; matchedBy: 'name' | 'code' }
  /** Neither the name nor the code found a row. */
  | { kind: 'unresolved'; code: string; name: string }
  /** Several rows match and nothing settles it. */
  | { kind: 'ambiguous'; code: string; name: string; candidates: readonly RiotTeamRecord[] };

export interface ResolveTeamInput {
  /** The primary join key. Compared after `normalizeTeamName`. */
  name: string;
  /** The fallback join key. Identifies the *organisation*, so a parent and its academy share it. */
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
   * Scope, not safety.
   *
   * This gate used to be the *safety* mechanism: joining on `code`, a `lck_challengers_league` match
   * asking for "KT" would find `kt Rolster`, because a parent and its academy share a code. Joining
   * on name removed that hazard — "kt Challengers" is simply absent from a narrowed table, so the
   * lookup misses instead of lying. The gate stays because refusing to spend work on a league we do
   * not cover is still correct, and because it keeps `code` fallback safe for the same reason.
   */
  if (input.tier !== 'major') return { kind: 'out-of-scope' };

  const unresolved = { kind: 'unresolved' as const, code: input.code, name: input.name };

  // ---- Primary: name -----------------------------------------------------
  const byName = index.byName.get(normalizeTeamName(input.name)) ?? [];
  if (byName.length === 1) {
    const only = byName[0];
    if (only !== undefined) return { kind: 'resolved', team: only, matchedBy: 'name' };
  }
  if (byName.length > 1) {
    // Zero of these exist in the current capture. If Riot ever produces one, the code can still act
    // as a tiebreak *within* the name candidates — narrower than falling back to a bare code lookup.
    const narrowed = byName.filter((c) => c.code === input.code);
    const only = narrowed[0];
    if (narrowed.length === 1 && only !== undefined) {
      return { kind: 'resolved', team: only, matchedBy: 'name' };
    }
    return { kind: 'ambiguous', code: input.code, name: input.name, candidates: byName };
  }

  // ---- Fallback: code ----------------------------------------------------
  const byCode = index.byCode.get(input.code);
  if (byCode === undefined || byCode.length === 0) return unresolved;
  if (byCode.length === 1) {
    const only = byCode[0];
    if (only === undefined) return unresolved;
    return { kind: 'resolved', team: only, matchedBy: 'code' };
  }

  if (input.override) {
    // The override must name a team that is actually in the table. A stale override pointing at a
    // team that has since been archived is a config bug, and silently honouring it would attach an
    // id nothing else in the system knows about.
    const chosen = byCode.find((c) => c.externalId === input.override?.teamId);
    if (chosen) return { kind: 'resolved', team: chosen, matchedBy: 'code' };
  }

  return { kind: 'ambiguous', code: input.code, name: input.name, candidates: byCode };
}
