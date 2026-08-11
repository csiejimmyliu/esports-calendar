/**
 * Wire shapes for Riot's REST esports API. Source DTOs, not domain models — they are mapped
 * explicitly in parse.ts and nothing outside this directory may import them.
 *
 * Two rules encoded here:
 *
 * 1. **Per endpoint, not per field name.** `tournament` is `{split, season}` from getSchedule and
 *    `{id}` from getEventDetails, with no overlap. A shared "Tournament" schema keyed on the
 *    field name would be wrong for one of them.
 * 2. **Enums are strings.** `state` and `type` are validated as plain strings and interpreted in
 *    parse.ts, which warns on unknown values. A zod enum would throw, and throwing on a value
 *    Riot added this morning empties the calendar — the exact failure mode the spec is built to
 *    avoid. A fixture proves existence, never absence.
 */

import { z } from 'zod';

/**
 * Riot signals failure with HTTP 200 and an `errors` array and no `data` key at all. Observed on
 * the VALORANT path: `{"errors":[{"message":"Invalid request parameters"}]}`. Reading `data`
 * first turns that into `undefined` and a zero-row parse that looks like a quiet day.
 */
export const RiotErrorEnvelope = z.object({
  errors: z.array(z.object({ message: z.string() }).passthrough()).min(1),
});

const Result = z.object({
  outcome: z.string().nullable().optional(),
  gameWins: z.number(),
});

/**
 * No `id`. In an 80-event getSchedule document, `"id"` occurs exactly 80 times — one per match,
 * zero for teams. This absence is why capabilities.teamIdentity is false for this endpoint.
 */
const ScheduleTeam = z.object({
  name: z.string(),
  code: z.string(),
  image: z.string().nullable().optional(),
  result: Result.nullable().optional(),
  record: z.object({ wins: z.number(), losses: z.number() }).nullable().optional(),
});

const ScheduleMatch = z.object({
  id: z.string(),
  flags: z.array(z.string()).optional(),
  teams: z.array(ScheduleTeam),
  strategy: z.object({ type: z.string(), count: z.number() }),
});

/**
 * `match` and `blockName` are optional because `type: "show"` events carry neither. All 80 events
 * in the LoL sample were `type: "match"`; 2 of 80 in the VALORANT sample — same backend — were
 * `show`. An adapter written from the LoL fixture alone passes its tests and then crashes on
 * `event.match.id` in production.
 */
export const ScheduleEvent = z.object({
  startTime: z.string(),
  state: z.string(),
  type: z.string(),
  blockName: z.string().nullable().optional(),
  league: z.object({ name: z.string(), slug: z.string() }),
  match: ScheduleMatch.optional(),
});

export const GetScheduleResponse = z.object({
  data: z.object({
    schedule: z.object({
      pages: z
        .object({ older: z.string().nullable(), newer: z.string().nullable() })
        .optional(),
      /**
       * Events are validated individually in parse.ts rather than here, so one malformed event
       * cannot reject the other 79. Partial failure isolation applies inside a response, not
       * only across sources.
       */
      events: z.array(z.unknown()),
    }),
  }),
});

export const GetLeaguesResponse = z.object({
  data: z.object({
    leagues: z.array(
      z.object({
        id: z.string(),
        slug: z.string(),
        name: z.string(),
        region: z.string().nullable().optional(),
        image: z.string().nullable().optional(),
        // `priority` is 1 for all 45 leagues and `displayPriority` is per-request UI state.
        // Both are read and both are ignored as tier signals. See lolesports-rest.md.
      }),
    ),
  }),
});

/**
 * `getTeams` takes no parameters beyond `hl` and returns the entire team master table — 1568 rows
 * on 2026-08-09. It is the endpoint that gives this adapter team identity at all.
 *
 * Two deliberate omissions:
 *
 * 1. **`players` is not declared.** The response carries a full roster per team. SPEC excludes
 *    player data from this project, and an undeclared field is stripped by zod rather than merely
 *    ignored downstream — so it cannot reach the domain by someone later spreading the object.
 * 2. **`status` is a plain string**, not a zod enum. Only `active` and `archived` were observed
 *    across all 1568 rows, and a fixture proves existence, never absence: a third value must warn,
 *    not throw.
 *
 * `homeLeague` is `{name, region}` — no slug and no id, and both fields are localized. It is the
 * only handle from a team to a league, which is a second independent reason every request pins
 * `hl=en-US` (see IDENTITY_LOCALE in client.ts).
 */
const TeamsHomeLeague = z.object({
  name: z.string(),
  region: z.string().nullable().optional(),
});

export const GetTeamsResponse = z.object({
  data: z.object({
    teams: z.array(
      z.object({
        id: z.string(),
        slug: z.string().nullable().optional(),
        name: z.string(),
        code: z.string(),
        image: z.string().nullable().optional(),
        alternativeImage: z.string().nullable().optional(),
        backgroundImage: z.string().nullable().optional(),
        status: z.string(),
        /** Null for 486 of the 1176 active rows: academy squads and regional teams. */
        homeLeague: TeamsHomeLeague.nullable().optional(),
      }),
    ),
  }),
});

export type ScheduleEventDto = z.infer<typeof ScheduleEvent>;
export type GetTeamsResponseDto = z.infer<typeof GetTeamsResponse>;
export type GetScheduleResponseDto = z.infer<typeof GetScheduleResponse>;
export type GetLeaguesResponseDto = z.infer<typeof GetLeaguesResponse>;
