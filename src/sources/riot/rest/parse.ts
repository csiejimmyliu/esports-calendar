/**
 * Pure mapping from Riot REST DTOs to the source layer.
 *
 * No I/O, no clock, no environment. This is the unit the golden fixture tests, and it is only
 * worth testing if it is deterministic — a parser that reads `new Date()` has a test that starts
 * failing three weeks after the fixture was captured, for a reason that has nothing to do with
 * the parser.
 */

import type { GameSlug, MatchState, SourceLeague, SourceMatch, SourceSide, SourceTeam } from '../../../core/types.js';
import { WarningCollector } from '../../../core/warnings.js';
import type { SourceWarning } from '../../../core/warnings.js';
import { normalizeToUtcIso } from '../../../core/time.js';
import { GetLeaguesResponse, GetScheduleResponse, ScheduleEvent } from './dto.js';
import type { ScheduleEventDto } from './dto.js';

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
}

const KNOWN_STATES: Record<string, MatchState> = {
  unstarted: 'unstarted',
  inProgress: 'inProgress',
  completed: 'completed',
};

/**
 * Riot serves team and league logos over plain http, which is blocked as mixed content on an
 * https page. Rewritten here rather than at render, so every consumer — web, ICS, iOS — gets the
 * same URL. Not warned per item: it is every logo in every response, and 80 identical warnings
 * is noise that hides the one warning that matters.
 */
function toHttps(url: string | null | undefined): string | null {
  if (!url) return null;
  return url.startsWith('http://') ? `https://${url.slice('http://'.length)}` : url;
}

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

  const sides = teams.map((t): SourceSide => {
    if (isTbd(t)) return { team: null, score: null };
    const team: SourceTeam = {
      // No team ids exist anywhere in this endpoint's response.
      externalId: null,
      name: t.name,
      code: t.code,
      logoUrl: toHttps(t.image),
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

  // Once per fetch, not once per team. Declared as a capability too, but a sync run reading only
  // warnings should still be able to see why no team crosswalk rows appeared.
  warn.warn('no-team-identity', 'Riot REST getSchedule exposes no team ids; teams cannot be crosswalked from this endpoint');

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
