/**
 * Pure mapping from Riot REST DTOs to the source layer.
 *
 * No I/O, no clock, no environment. This is the unit the golden fixture tests, and it is only
 * worth testing if it is deterministic — a parser that reads `new Date()` has a test that starts
 * failing three weeks after the fixture was captured, for a reason that has nothing to do with
 * the parser.
 */

import type { LeagueConfig } from '../../../config/leagues.js';
import type { GameSlug, MatchState, SourceLeague, SourceMatch, SourceSide, SourceTeam } from '../../../core/types.js';
import { WarningCollector } from '../../../core/warnings.js';
import type { SourceWarning } from '../../../core/warnings.js';
import { normalizeToUtcIso } from '../../../core/time.js';
import { GetLeaguesResponse, GetScheduleResponse, ScheduleEvent } from './dto.js';
import type { ScheduleEventDto } from './dto.js';
import { toHttps } from './https.js';
import { resolveTeam } from './teams.js';
import type { TeamIndex } from './teams.js';

export interface ParseOutput<T> {
  items: T[];
  warnings: SourceWarning[];
}

export interface ParseScheduleOptions {
  game: GameSlug;
  /**
   * league slug -> Riot league id, from getLeagues. Absent when that request failed; matches are
   * still produced, with `leagueExternalId: null` and a `degraded-fetch` warning from the caller.
   */
  leagueIdBySlug?: ReadonlyMap<string, string>;
  /** The hand-maintained tier table. Decides which matches get their teams resolved at all. */
  leagueConfig: LeagueConfig;
  /**
   * Absent when getTeams failed. Every team then keeps its name with `externalId: null`, and the
   * caller raises `no-team-identity` — a calendar without crosswalk ids beats no calendar.
   */
  teamIndex?: TeamIndex;
}

const KNOWN_STATES: Record<string, MatchState> = {
  unstarted: 'unstarted',
  inProgress: 'inProgress',
  completed: 'completed',
};

/**
 * Riot's TBD convention on REST: `code: "TBD"` **and** `result: null` together.
 *
 * Both halves are required. A known team that has not played yet has `result: {gameWins: 0,
 * outcome: null}` — falsy-looking, and a different thing entirely. Testing only `result == null`
 * would be right here and wrong the moment a real team's result is briefly absent.
 */
function isTbd(team: { code: string; result?: unknown }): boolean {
  return team.code === 'TBD' && (team.result === null || team.result === undefined);
}

function parseEvent(
  raw: unknown,
  opts: ParseScheduleOptions,
  warn: WarningCollector,
): SourceMatch | null {
  const parsed = ScheduleEvent.safeParse(raw);
  if (!parsed.success) {
    warn.warn('unparsable-item', `event failed schema validation: ${parsed.error.message}`, raw);
    return null;
  }
  const event: ScheduleEventDto = parsed.data;

  if (event.type !== 'match') {
    // `show` is a known non-match event (analyst desk, pre-game programming) and carries no
    // `match` object. Anything else is a value Riot introduced without telling us: not a match
    // as far as we know, but worth saying out loud rather than dropping in silence.
    if (event.type !== 'show') {
      warn.warn('unknown-event-type', `unrecognised event type ${JSON.stringify(event.type)}`, event.type);
    }
    return null;
  }

  if (!event.match) {
    warn.warn('unparsable-item', 'event has type "match" but no match object', event);
    return null;
  }

  const teams = event.match.teams;
  if (teams.length !== 2) {
    // Skipped rather than crashed on. One malformed match must not empty a calendar.
    warn.warn(
      'non-binary-sides',
      `match ${event.match.id} has ${String(teams.length)} participants, expected 2`,
      event.match.id,
    );
    return null;
  }

  const reported = KNOWN_STATES[event.state];
  if (reported === undefined) {
    warn.warn('unknown-match-state', `unrecognised state ${JSON.stringify(event.state)}`, event.state);
  }

  /**
   * Correct the state rather than merely flagging it.
   *
   * Riot REST's `state` is unusable for matches with an undecided opponent: across the captured
   * 80 events, the 7 TBD matches split 3 `completed` / 4 `unstarted`, and two of those sit in the
   * same tournament one day apart with opposite values. There is no rule to be found there.
   *
   * `result` is the reliable signal, and it is exact: all 7 unplayed matches have `result: null`
   * on both sides, and not one of the 73 matches with real teams does. A team that is playing but
   * has not won a game yet has `{gameWins: 0, outcome: null}` — present, and a different thing.
   *
   * So: a null result means not played, whatever `state` says. This is inference, which is why
   * the adapter declares `explicitState: false` despite the field existing.
   */
  const hasNullResult = teams.some((t) => t.result === null || t.result === undefined);
  const resolvedState: MatchState = hasNullResult ? 'unstarted' : (reported ?? 'unstarted');

  if (hasNullResult && reported !== 'unstarted') {
    warn.warn(
      'lossy-state',
      `corrected match ${event.match.id} from ${JSON.stringify(event.state)} to "unstarted": no result on at least one side, so it has not been played`,
      event.match.id,
    );
  }

  /**
   * Tier is a property of the league the match is played under, and it decides whether team
   * resolution is attempted at all — see resolveTeam. Warned once per event rather than per side,
   * and only for `unclassified`: an explicit `minor` is a decision already recorded in the config
   * file, while an absent slug is a league that appeared upstream after the file was reviewed.
   */
  const tier = opts.leagueConfig.tierFor(event.league.slug);
  if (tier === 'unclassified') {
    warn.warn(
      'unclassified-league',
      `league ${JSON.stringify(event.league.slug)} is absent from config/leagues.json; its matches carry no team ids until it is classified`,
      event.league.slug,
    );
  }

  const sides = teams.map((t): SourceSide => {
    if (isTbd(t)) return { team: null, score: null };

    // getSchedule itself has no team ids; everything below comes from the getTeams join.
    let externalId: string | null = null;
    let logoUrl = toHttps(t.image);

    if (opts.teamIndex !== undefined) {
      const resolution = resolveTeam(opts.teamIndex, {
        name: t.name,
        code: t.code,
        leagueSlug: event.league.slug,
        tier,
        override: opts.leagueConfig.overrideFor(t.code, event.league.slug),
      });
      switch (resolution.kind) {
        case 'resolved':
          externalId = resolution.team.externalId;
          // The master table's image is the newer asset of the two. It is not the more secure one
          // — most of them are http as well, which is why toHttps still runs over it.
          logoUrl = resolution.team.logoUrl ?? logoUrl;
          if (resolution.matchedBy === 'code') {
            // Right answer, but the two endpoints no longer agree on this team's name. See the
            // warning's own comment: this is notice before the next rebrand misses outright.
            warn.warn(
              'team-name-mismatch',
              `${JSON.stringify(t.name)} in league ${event.league.slug} did not match any name in the master table; resolved by code ${JSON.stringify(t.code)} to ${JSON.stringify(resolution.team.name)}`,
              { scheduleName: t.name, tableName: resolution.team.name, code: t.code },
            );
          }
          break;
        case 'unresolved':
          warn.warn(
            'team-unresolved',
            `no team in the master table matches ${JSON.stringify(t.name)} by name or ${JSON.stringify(t.code)} by code, seen in league ${event.league.slug}`,
            { code: t.code, name: t.name, league: event.league.slug },
          );
          break;
        case 'ambiguous':
          warn.warn(
            'team-ambiguous',
            `${JSON.stringify(t.name)} / code ${JSON.stringify(t.code)} in league ${event.league.slug} is claimed by ${String(resolution.candidates.length)} teams and no override settles it; left unidentified rather than guessed`,
            { name: t.name, code: t.code, candidates: resolution.candidates.map((c) => c.externalId) },
          );
          break;
        case 'out-of-scope':
          // Deliberate and silent. Roughly half the events in an unfiltered getSchedule are out of
          // scope, and warning on each would bury every warning that means something.
          break;
      }
    }

    const team: SourceTeam = {
      externalId,
      name: t.name,
      code: t.code,
      logoUrl,
    };
    return { team, score: t.result?.gameWins ?? null };
  }) as [SourceSide, SourceSide];

  /**
   * getSchedule has no `games` array, so games played is reconstructed from the per-team win
   * counts. That counts *decided* games only: a Bo3 with game 3 underway reports 2. seriesLength
   * is unaffected — it comes from strategy.count and is always available.
   */
  const gamesPlayed = sides.reduce((sum, s) => sum + (s.score ?? 0), 0);

  return {
    externalId: event.match.id,
    game: opts.game,
    leagueExternalId: opts.leagueIdBySlug?.get(event.league.slug) ?? null,
    leagueSlug: event.league.slug,
    // getSchedule carries no tournament at all — VALORANT's copy of this endpoint does.
    tournamentExternalId: null,
    startsAtUtc: normalizeToUtcIso(event.startTime, 'event.startTime'),
    state: resolvedState,
    seriesLength: event.match.strategy.count,
    gamesPlayed,
    sides,
    stageLabel: event.blockName ?? null,
    // Riot exposes no streams. Settled, not pending: League.defaultStreamUrl covers it.
    streamUrl: null,
  };
}

export function parseSchedule(raw: unknown, opts: ParseScheduleOptions): ParseOutput<SourceMatch> {
  const warn = new WarningCollector();
  const envelope = GetScheduleResponse.parse(raw);
  const events = envelope.data.schedule.events;

  const items: SourceMatch[] = [];
  for (const event of events) {
    const match = parseEvent(event, opts, warn);
    if (match) items.push(match);
  }

  if (items.length === 0) {
    warn.warn(
      'suspect-empty',
      'getSchedule returned no usable matches; the endpoint answered but the calendar would be empty',
    );
  }

  /**
   * This used to be unconditional: getSchedule alone exposes no team ids, so every fetch said so.
   * It is now conditional on the join actually being unavailable, because the adapter supplies the
   * getTeams index and the normal case does have identity. Left in place for the degraded case —
   * a sync run reading only warnings must still be able to see why no crosswalk rows appeared.
   */
  if (opts.teamIndex === undefined) {
    warn.warn(
      'no-team-identity',
      'no team master table available; getSchedule alone exposes no team ids, so nothing can be crosswalked',
    );
  }

  return { items, warnings: warn.list() };
}

export function parseLeagues(raw: unknown, game: GameSlug): ParseOutput<SourceLeague> {
  const warn = new WarningCollector();
  const envelope = GetLeaguesResponse.parse(raw);

  const items = envelope.data.leagues.map(
    (l): SourceLeague => ({
      externalId: l.id,
      game,
      slug: l.slug,
      name: l.name,
      region: l.region ?? null,
      logoUrl: toHttps(l.image),
    }),
  );

  if (items.length === 0) {
    warn.warn('suspect-empty', 'getLeagues returned no leagues');
  }

  return { items, warnings: warn.list() };
}
