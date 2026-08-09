# Source: BLAST (Counter-Strike 2)

Probed 2026-08-09. Fixtures: `fixtures/blast-cs/{bounty-2026-season-2,esports-world-cup-2026-cs2}_{matches,brackets}.json`,
each with a `.meta.json` sidecar. The original probe write-up, which was a hand-assembled merge of
two tournaments and two endpoints rather than a replayable response, is kept as
`docs/sources/blast-probe-notes-2026-08-09.json`.

> **Unreviewed finding, 2026-08-09 re-capture.** `esports-world-cup-2026-cs2` starts 2026-08-12
> and its full schedule exists — in `/brackets`. Its `/matches` returns HTTP 200 and `[]` in the
> same minute. If that generalises, an upcoming tournament has no rows in `/matches` at all, and
> the "join the two endpoints for state" model below understates the problem: `/brackets` is not
> an enrichment, it is the only forward-looking source. Not yet folded into the sections below —
> see the sidecar on `esports-world-cup-2026-cs2_matches.json`.

This is the source that actually tests the abstraction. Everything below diverges from Riot in a
way that constrains the interface.

## Endpoints

```
GET https://api.blast.tv/v2/games/cs/tournaments/{tournamentSlug}/matches
GET https://api.blast.tv/v2/games/cs/tournaments/{tournamentSlug}/brackets
```

- REST, Fastify backend. No auth on these routes. `/v1/` exists on this domain but only for
  polls and fantasy (auth-gated), not schedules.
- `origin: https://blast.tv` required for CORS.

## The defining difference: no global schedule

Riot exposes `getSchedule` with no required parameters and returns every match across every
league. **BLAST requires a tournament slug in the path.** There is no endpoint that returns "all
CS matches." The tournament list page is server-rendered, so no tournament-list API was found.

Consequence for the interface: fetching cannot be `getSchedule()`. It must be two-phase —
enumerate scopes, then fetch per scope. Riot implements scope enumeration trivially (one global
scope); BLAST returns one scope per tournament.

**Open problem**: how are tournament slugs discovered? Options, in order of preference:
1. An undiscovered tournaments endpoint (probe `/v2/games/cs/tournaments`)
2. Parse the SSR tournaments page
3. Maintain the slug list manually alongside the league tier table

## No league tier

The hierarchy is `tournament → stage → match`. There is no league.

`circuit` (`{gameId: "cs", id: "cs-2026", name: "CS 2026"}`) is a year tag shared by every 2026 CS
tournament. It has no schedule, standings, or format of its own — not a league.

**`league` must be optional in the domain model.** This also has a product consequence: following
"LCK" means following a durable entity, but following "IEM Katowice" is meaningful for two weeks.
CS users will follow **teams**, or possibly **organizers**.

## Two vocabularies for the same entity

The same match, from the same API, in two endpoints:

| Concept | `/matches` | `/brackets` |
|---|---|---|
| match id | `id` | `uuid` |
| start time | `scheduledAt` | `timeOfSeries` |
| team id | `id` | `uuid` |
| team short name | `shortName` | `shorthand` |
| team region | `nationality` | `location` |
| map start | `startedAt` | `actualStartTime` |
| map end | `endedAt` | `matchEndedTime` |

Values are identical; names are not. Mapping must be per-endpoint.

## State requires both endpoints

`/matches` has **no state field at all** — state must be inferred from `teamAScore`/`teamBScore`
and whether `maps[]` is populated. `/brackets` has `isLive` and `isCompleted`.

So either join the two, or derive. Riot hands you `state` directly.

`/brackets` also carries `winnerGoesTo` / `loserGoesTo` (bracket progression) — out of v1 scope,
but it is the only source with it.

## Conventions that invert Riot's

### TBD opponents
```json
{ "teamA": null, "teamB": null, "teamAScore": 0, "teamBScore": 0, "maps": [] }
```
Plain `null`. No placeholder object, no `"TBD"` string, no sentinel id.

Riot uses `{code: "TBD", id: "{matchId}:0"}`. **TBD must be a first-class concept in the domain
model**, not a source convention leaking through.

### Bo3 that ended 2-0
`maps` contains **exactly two entries**. There is no third placeholder.

Riot pre-generates all three and marks the unplayed one `"unneeded"`.

**Therefore `seriesLength` (from `type: "BO3"`) and `gamesPlayed` (from `maps.length`) are
different values and must be stored separately.** On Riot they happen to be equal, so a
Riot-only implementation would never surface the distinction.

### Streams — BLAST has them, Riot does not
```json
"metadata": { "externalStreamUrl": "https://www.twitch.tv/blastpremier" }
```
Per-match, Twitch or YouTube. Absent on TBD matches.

Ironic reversal: we adopted a manual league→channel mapping because Riot exposes no streams.
BLAST supplies them per match. **Stream availability is a declared source capability**: use the
source's URL when present, fall back to the mapping table when not.

## Error shapes — three, all different from Riot's

| Case | Response |
|---|---|
| Unknown tournament slug | **200 + `[]`** |
| Unknown sub-route | 404 + `{"code":"not-found","message":"Route GET:… not found"}` |
| Auth-gated `/v1/` route | 401 |

Riot returns 200 + `{"errors":[{"message":…}]}`.

**The first row is the dangerous one.** An unknown slug is indistinguishable from a real
tournament with no matches scheduled yet — both are a silent empty array. Typo a slug and that
tournament vanishes from the calendar with every health check green.

This is the field instance of the failure mode the spec has been guarding against. A per-scope
semantic canary is mandatory, not advisory.

## Other details worth not discovering the hard way

- **Ids are UUIDs**, not Riot's numeric snowflakes. `external_id` is a string; assume nothing
  about its format.
- **Timezone markers are inconsistent within one object**: `scheduledAt` is
  `"2026-08-02T10:30:00.000Z"`, but `tournament.startDate` is `"2026-07-21T12:00:00"` — **no Z**.
  Parse per field, never with one shared parser.
- **No non-match events.** `metadata._t` was `"cs_match"` throughout. No `show` equivalent found.
- **Liquipedia cross-reference is built in**:
  ```json
  "metadata": { "references": { "liquipedia": { "teamName": "MOUZ", "pageId": 19674 } } }
  ```
  A ready-made shared identifier for cross-source identity. Store it in `external_ref`.
- `stage` (`{id, name, format, startDate, endDate, index}`) sits between tournament and match.
  Roughly analogous to Riot's `blockName`, but structured rather than free text.

## Fallbacks if BLAST becomes unusable

HLTV, or Liquipedia's CS2 wiki. Liquipedia is the only option with published API terms, and its
MediaWiki shape is even more foreign than BLAST's — a stricter abstraction test, at the cost of
harsh rate limits and CC-BY-SA attribution.
