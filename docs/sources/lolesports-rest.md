# Source: LoL Esports REST API (secondary)

Probed 2026-08-09 against `fixtures/lolesports/rest_getSchedule.json` (80 events, 21 leagues).

## Endpoint

- **Base**: `https://esports-api.lolesports.com/persisted/gw/`
- **Auth**: `x-api-key: 0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z` — static, publicly documented,
  unchanged for years
- **Locale**: `hl=en-US`. Use en-US as the canonical identity locale for the whole system.
- **Pagination**: real, working. `data.schedule.pages.{older,newer}` return base64 cursors.
- Endpoints: `getSchedule`, `getLeagues`, `getTournamentsForLeague`, `getTeams`,
  `getEventDetails`, `getStandings`, `getLive`, `getCompletedEvents`

## Response shape

```
data.schedule.pages { older, newer }        -- base64 cursors, populated
data.schedule.events[]
  startTime, state, type, blockName
  league  { name, slug }                    -- no id, no image, no priority
  match
    id                                      -- the only id in the entire document
    flags[]
    strategy { type, count }
    teams[]
      name, code, image                     -- NO ID
      result { outcome, gameWins }          -- null when TBD
      record { wins, losses }               -- season W/L, not in GraphQL
```

Complete key inventory of the document: `blockName, code, count, data, events, flags, gameWins,
id, image, league, losses, match, name, newer, older, outcome, pages, record, result, schedule,
slug, startTime, state, strategy, teams, type, wins`.

There is no `streams` key anywhere.

## Why this is the SECONDARY source

### 1. No team identifiers in the bulk endpoint
In `getSchedule`, `"id"` occurs exactly 80 times in the 80-event document — one per match, zero
for teams. Teams carry only `name` and `code`, both unstable (renames; codes collide across
leagues — TL, KC, FX all recur).

`getEventDetails` **does** return plain team ids, and they match the suffix of the GraphQL
composite id exactly:

| Source | Team identifier for Suzhou LNG Esports |
|---|---|
| GraphQL `homeEvents` | `"116566854547835328:99566404850008779"` |
| REST `getEventDetails` | `"99566404850008779"` |

Two independent endpoints agreeing confirms `99566404850008779` is Riot's canonical team id.
Use it in `external_ref`.

But `getEventDetails` is one call per match, so it cannot drive bulk sync. Bulk still requires
splitting the GraphQL composite id.

### 2. `state` is lossy and reports wrong answers
Cross-checked against the GraphQL sample for the same five match ids:

| match id | league | REST `state` | GraphQL `match.state` |
|---|---|---|---|
| 117047583684384478 | cacg | `completed` | **`unstarted`** |
| 117047583684384474 | cacg | `completed` | **`unstarted`** |
| 116696189685662215 | lit | `completed` | `completed` |
| 115548681803406135 | lec | `completed` | `completed` |
| 116566854547835328 | lpl | `unstarted` | `unstarted` |

The two divergent rows are playoff matches with `teams[].code == "TBD"`, `result: null`, and no
VOD flag — they have plainly not been played. REST has only one `state` field, so the true value
is unrecoverable from `state` alone. A calendar built on `state` would show unplayed playoff
matches as finished.

### The full picture — verified against all 80 events, 2026-08-09

*Confidence: exhaustive. Every event in `rest_getSchedule.json` was classified, not sampled.*

The five-id cross-check above found two bad rows. There are **three**:

| match id | league | starts | REST `state` | actually |
|---|---|---|---|---|
| 117047583684384478 | cacg | 2026-08-07T20:05Z | `completed` | not played |
| 117047583684384474 | cacg | 2026-08-07T20:55Z | `completed` | not played |
| **116929376557102192** | **kespa_cup** | **2026-08-10T10:30Z** | **`completed`** | **not played** |

The third one **starts the day after this fixture was captured**. So "state is only wrong for
stale placeholders in the past" is not a safe rule — a future match can be reported as finished.

Worse, `state` has no rule at all for undecided matches. Two `kespa_cup` TBD matches one day
apart disagree with each other: one `completed`, one `unstarted`. Distribution across all 80:

```
TBD, result null, state completed   3
TBD, result null, state unstarted   4
real teams, result null             0
one side null, other not            0
```

### `result === null` is exact, not a workaround

Seven matches have `result: null`, and all seven are unplayed. None of the 73 played matches has
a null result, and no match is null on one side only. The correspondence has **zero exceptions**
in the captured sample.

So the adapter **overrides** `state` rather than flagging it: a null result on either side means
`unstarted`, whatever `state` says. `flags` and `hasVod` are not needed — `result` alone settles
it. Because the reported state is derived, `riot-rest-lol` declares `capabilities.explicitState:
false` even though the field exists.

Note that `{gameWins: 0, outcome: null}` is a **present** result belonging to a real team that
has not won a game. Only an absent `result` means unplayed; conflating the two would erase every
upcoming match.

*Caveat: exhaustive over one capture, not over time. If a future capture shows a played match
with a null result, this rule is wrong and the correction becomes a silent data loss — so the
7/73/0 distribution is asserted as a test, not left as a comment.*

### 3. No stream links
Absent from `getSchedule` entirely. Unresolved whether `getEventDetails` or `getLive` supply them.

## What REST is good for

- **Failover** when the GraphQL persisted hash is invalidated by a frontend deploy.
- **Historical backfill** — its cursors actually work; the GraphQL ones were null.
- `record { wins, losses }` if standings are ever wanted (out of scope for v1).

## Scope filtering problem

A single unfiltered call returned 21 leagues, most of them outside our "officially broadcast major
events" scope:

`arabian_league, cacg, cblol-brazil, hitpoint_masters, kespa_cup, lck, lck_challengers_league,
lcp, lcs, lec, lit, ljl-japan, lpl, nacl, nlc, north_regional_league, pcs, primeleague,
rift_legends, roadoflegends, turkiye-sampiyonluk-ligi`

### There is no tier signal in the API — verified

`getLeagues` returns 45 leagues, each with `id, slug, name, region, image, priority,
displayPriority{position, status}`.

- **`priority` is `1` for all 45 leagues.** Useless.
- **`displayPriority` is per-request UI state, not a league property.** Proof: CACG returned
  `{position: 1000, status: "hidden"}` from GraphQL `homeEvents` and `{position: 5, status:
  "selected"}` from REST `getLeagues` on the same day. Also **LCK and LPL are `not_selected`** —
  it plainly does not encode importance.

`status` values and what they actually mean:

| Value | Leagues | Meaning |
|---|---|---|
| `force_selected` | Worlds, MSI, First Stand | International majors, always shown |
| `selected` / `not_selected` | everything current | Default checkbox state; varies per request |
| `hidden` | LTA North/South/Cross, LLA, LCO, LCL, WQS, King's Duel | **Discontinued leagues** |

`hidden` is genuinely useful — for suppressing dead leagues, not for tiering. It corroborates the
2026 restructure (LTA dissolved; LCS and CBLOL reinstated).

### Consequence: maintain our own tier classification

Sync **all** leagues into the DB with a `tier` column (`major` / `minor` / `unclassified`). New
leagues default to `unclassified` and are surfaced for manual review rather than silently included
or dropped. Three leagues appeared in 2026 alone (EWC, CACG, FLS), so this needs a process, not a
hardcoded array.

`region` (`KOREA`, `CHINA`, `INTERNATIONAL`, `EMEA`, …) is a usable free grouping for the UI.

### `tft_esports` is in the league list

TFT is a different game. Multi-title support is required by the **first** source, not deferred to
VALORANT. Useful validation target for the Stage 0 interface.

## Endpoint-specific notes

**`getEventDetails?id=<matchId>`** — enrichment only. Returns team ids, `league.id`,
`tournament.id`, and `games[].teams[].side` (blue/red). Does **not** return `startTime`, `state`,
or `blockName`, so it cannot back a calendar on its own.

**`getLive`** — returned `{"events": []}` when probed; no matches were live at the time. This is
an inconclusive result, not evidence that streams are absent. Re-probe during an actual broadcast.

## Open questions

1. **Do stream links ever appear?** Still unresolved. `getSchedule` has no `streams` key at all;
   `getEventDetails` returned `[]` for an unstarted match; `getLive` was empty because nothing was
   live. **Re-run `getLive` during an LCK or LPL broadcast.** Blocks FR-4, and determines whether
   a separate pre-broadcast fetch path is needed in the architecture.
2. Does `getTeams?id=<leagueId>` return the same team ids as `getEventDetails`? If so it is the
   cheap way to build the team master table in bulk.
