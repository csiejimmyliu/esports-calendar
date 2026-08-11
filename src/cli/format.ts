/**
 * Pure selection and rendering for the CLI. Separate from next-matches.ts so tests can import
 * these without executing the entry point.
 */

import type { SourceMatch } from '../core/types.js';
import { addDays, formatInZone, parseUtcInstant } from '../core/time.js';

export interface SelectOptions {
  leagueSlug: string;
  days: number;
  now: Date;
}

/**
 * Exact slug equality, deliberately: `lck` and `lck_challengers_league` are different leagues
 * that both survive a prefix or substring test, and the challengers league runs on days the main
 * league does not — so a sloppy match does not merely add rows, it adds the wrong ones.
 */
export function selectUpcoming(matches: readonly SourceMatch[], opts: SelectOptions): SourceMatch[] {
  const from = opts.now.getTime();
  const to = addDays(opts.now, opts.days).getTime();
  return matches
    .filter((m) => m.leagueSlug === opts.leagueSlug)
    .filter((m) => {
      const at = parseUtcInstant(m.startsAtUtc, 'match.startsAtUtc');
      return at >= from && at <= to;
    })
    .sort((a, b) => a.startsAtUtc.localeCompare(b.startsAtUtc));
}

/**
 * `CODE#id`, or `CODE#?` when the team was named but not identified.
 *
 * The id is printed because Stage 0.5's whole deliverable is that it exists — a run that prints
 * only names cannot show the difference between a resolved team and an unresolved one, which is
 * exactly the failure this stage is meant to make visible.
 */
function sideLabel(side: SourceMatch['sides'][number]): string {
  const team = side.team;
  if (team === null) return 'TBD';
  const name = team.code ?? team.name;
  return `${name}#${team.externalId ?? '?'}`;
}

/** Counts the three outcomes a printed run should be judged on. */
export interface ResolutionTally {
  resolved: number;
  unidentified: number;
  tbd: number;
}

export function tallyResolution(matches: readonly SourceMatch[]): ResolutionTally {
  const tally: ResolutionTally = { resolved: 0, unidentified: 0, tbd: 0 };
  for (const match of matches) {
    for (const side of match.sides) {
      if (side.team === null) tally.tbd += 1;
      else if (side.team.externalId === null) tally.unidentified += 1;
      else tally.resolved += 1;
    }
  }
  return tally;
}

export function formatMatchLine(match: SourceMatch, tz: string, spoilers: boolean): string {
  const { date, time, weekday } = formatInZone(match.startsAtUtc, tz);
  const [a, b] = match.sides;
  const teams = `${sideLabel(a)} vs ${sideLabel(b)}`;
  const bo = match.seriesLength === null ? '' : `Bo${String(match.seriesLength)}`;

  // Spoiler-free is the default and applies to completed matches too (FR-3).
  const score =
    spoilers && match.state === 'completed' ? `  ${String(a.score ?? 0)}-${String(b.score ?? 0)}` : '';

  return [`${weekday} ${date}`, time.padEnd(5), teams.padEnd(46), bo.padEnd(3), match.stageLabel ?? '', score]
    .join('  ')
    .trimEnd();
}

export interface Args {
  league: string;
  days: number;
  tz: string;
  now: string | null;
  live: boolean;
  spoilers: boolean;
  /** Which captured schedule to read in offline mode. Ignored with --live. */
  fixture: string;
}

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    league: 'lck',
    days: 7,
    tz: 'Asia/Taipei',
    now: null,
    live: false,
    spoilers: false,
    fixture: 'rest_getSchedule.json',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case '--league':
        if (value === undefined) throw new Error('--league needs a value');
        args.league = value;
        i += 1;
        break;
      case '--days':
        if (value === undefined) throw new Error('--days needs a value');
        args.days = Number(value);
        if (!Number.isFinite(args.days)) throw new Error(`--days must be a number, got ${value}`);
        i += 1;
        break;
      case '--tz':
        if (value === undefined) throw new Error('--tz needs a value');
        args.tz = value;
        i += 1;
        break;
      case '--now':
        if (value === undefined) throw new Error('--now needs a value');
        args.now = value;
        i += 1;
        break;
      case '--fixture':
        if (value === undefined) throw new Error('--fixture needs a value');
        // A bare filename under fixtures/riot-lol/, not a path: the CLI reads committed captures,
        // it is not a general-purpose JSON viewer.
        if (value.includes('/') || value.includes('..')) {
          throw new Error(`--fixture takes a file name under fixtures/riot-lol/, got ${JSON.stringify(value)}`);
        }
        args.fixture = value;
        i += 1;
        break;
      case '--live':
        args.live = true;
        break;
      case '--spoilers':
        args.spoilers = true;
        break;
      default:
        throw new Error(`unknown argument ${JSON.stringify(flag)}`);
    }
  }
  return args;
}
