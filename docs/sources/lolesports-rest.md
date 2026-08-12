# Source: LoL Esports REST API — the only implemented source

Probed 2026-08-09 against `fixtures/riot-lol/rest_getSchedule.json` (80 events, 21 leagues).

> **This note was written while REST was the *secondary* source, with GraphQL intended as primary.
> That is no longer true and the title has been corrected.** GraphQL was primary for two reasons: it
> carried team ids and a trustworthy `match.state`. The `getTeams` section below removed the first and
> the `result` section removed the second, which took GraphQL off the roadmap entirely. Passages that
> still reason about "splitting the GraphQL composite id" as necessary work are historical; they are
> kept because they are how the identity question was answered, and flagged where they appear.

> **Coverage changed on 2026-08-11.** Every figure in the `getTeams` section that depends on which
> leagues are covered was measured under the previous fourteen-league table and has been re-measured
> under the current eight. Where a number appears below, it says which coverage it belongs to.

**Stage 0.8, 2026-08-12: every parameter and boundary claim in this file has now been measured, not
assumed.** `docs/sources/riot-rest-parameters.md` is the reference — a parameter table per endpoint,
each cell citing the probe id that established it, plus a full probe log with a machine-readable
twin at `docs/probes/riot-rest/*.probe.json`. This file stays the interpretive note; corrections below
mark where a probe changed what was believed here.

## Endpoint

- **Base**: `https://esports-api.lolesports.com/persisted/gw/`
- **Auth**: a static `x-api-key` that the site ships to every browser. Value in `.env.example` and
  read from `RIOT_ESPORTS_API_KEY`; it is deliberately not repeated here, because the fixture sidecars
  redact it and having it in three places made the redaction meaningless.
  *Confidence: it worked unchanged across every probe on 2026-08-09. Nothing here establishes how long
  it has been stable — "unchanged for years" was asserted in an earlier draft with no evidence and is
  withdrawn. The client treats a 4xx as final precisely so a rotated key fails loudly.*
- **Locale**: `hl=en-US`. Use en-US as the canonical identity locale for the whole system.
- **Pagination — verified, exhaustive over one forward crawl, 2026-08-12T02:25Z.** `getSchedule`
  accepts `pageToken`. The value is base64; it decodes to `newer::<snowflake>` or
  `older::<snowflake>`, and the snowflakes are the same id space as `match.id`.

  Forward crawl from an unparameterised call, following `data.schedule.pages.newer`: **6 requests,
  page sizes 80/80/80/80/80/36 = 436 events**, horizon `2026-08-09T15:00Z` → `2026-10-10T16:00Z`.
  The sixth page returned `pages.newer: null`. *Basis: exhaustive over this one crawl; n = 6
  requests, 436 events. It is not evidence about any other day.*

  **A page is 80 events, not a time range.** Page 6 alone spans a month while page 1 spans four
  days — window width is a function of match density, so no time-based assumption about page width
  is safe, and none is made. `pages.newer === null` is the only termination condition used.

  Page spans are contiguous and ascending, and no `match.id` appeared on two pages. *Basis:
  exhaustive over the committed crawl corpus (`fixtures/riot-lol/rest_getSchedule_crawl_2026-08-12/`);
  asserted in `tests/fixture-crawl.test.ts`, not only stated here.*

  **`leagueId` does not silently truncate, and it is not a single-page endpoint — an earlier
  version of this line said it was.** `leagueId=98767991310872058` (lck) returned 80 events with
  `pages.newer: null` and **`pages.older` non-null**. Cross-checked against the global forward
  crawl over the overlapping range: zero events in the set difference in either direction. *Basis:
  cross-checked, one league, one day.* The earlier claim — that a `leagueId` call "returns that
  league's full history in one page" — generalised from `ewc_lol`'s 28-event capture, which merely
  *fit* inside the 80-event page; it does not, and `rest_getSchedule_ewc.meta.json`'s
  `verification.pages` note is corrected to match.

  **The `older` (backward) direction is unprobed to termination.** A 6-page backward crawl from the
  same anchor point (2026-08-12) did **not** terminate: 480 events, back to `2026-07-19`,
  `pages.older` still non-null on the sixth page. Forward and backward are not symmetric on the
  evidence so far. Past matches are in scope (SPEC §1), so historical backfill needs this direction,
  and nothing here establishes that it terminates at all, or in how many pages.

  **Stage 1a decision, 2026-08-12: no backfill is built.** The owner does not need historical
  matches reconstructed from before sync existed. `fetchMatches` still only crawls forward, so a
  freshly-deployed sync reaches roughly three days into the past on day one (the forward crawl's
  own horizon, above) and accumulates further history only from matches it has actually ingested —
  upsert-and-never-delete, not backfill. This is not a change to `timeWindow` or any capability
  flag; it is a statement about what stage 1a's sync worker chooses to call, not about what the
  endpoint can do. If the `older` direction is later needed, this section's crawl-termination gap
  is still open and would need resolving first.
- Endpoints: `getSchedule`, `getLeagues`, `getTournamentsForLeague`, `getTeams`,
  `getEventDetails`, `getStandings`, `getLive`, `getCompletedEvents` — **and `getGames`, found only
  by cross-referencing community documentation** (`vickz84259.github.io/lolesports-api-docs`,
  `kingjakeu/lolesports`'s unofficial guide) after this project's own live probing had already run;
  it had never been named here at all. **As of Stage 0.8, all nine have been probed at least once —
  see `docs/sources/riot-rest-parameters.md`.** The five this project never calls
  (`getTournamentsForLeague`, `getStandings`, `getLive`, `getCompletedEvents`, `getGames`) all
  returned real data when probed. `getCompletedEvents` bears directly on the still-open "past
  matches" product question (SPEC §1 vs the owner's later comment that they are "no longer
  important" — unresolved, see the Stage 0.8 plan's open items) — but the first probe of it used
  the wrong parameter: `leagueId` is silently ignored, `tournamentId` is the real one, and a
  same-run comparison against a no-params anchor caught the mistake before it was written up as a
  confirmed capability. See `riot-rest-parameters.md`'s `doc-cross-check` group.
- **Unrecognised query parameters are silently ignored, not rejected** — verified by sending
  `getSchedule?...&thisParamDoesNotExist=1` and getting a byte-identical response to the
  unparameterised anchor. This bounds every "endpoint X has no parameter Y" claim in this file: none
  of them were established by "adding the parameter produced no visible error", because that method
  cannot distinguish a nonexistent parameter from an ignored real one. Where a claim below says a
  parameter narrows or changes a response, it was established by comparing against a same-run anchor,
  not by the absence of an error. See `docs/sources/riot-rest-parameters.md`.

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

*Confidence: cross-checked, **n = 1 team**, across two endpoints. Two endpoints agreeing on one team
is consistent with `99566404850008779` being Riot's canonical team id; it does not establish it. The
`getTeams` section below raises this to three endpoints and two teams, which is still n = 2. The
claim is well-supported and the earlier wording ("confirms") overstated a two-cell table.*

But `getEventDetails` is one call per match, so it cannot drive bulk sync.

> **Superseded.** This section originally concluded "bulk still requires splitting the GraphQL
> composite id". It does not: `getTeams` returns the whole master table with these same plain ids, so
> bulk identity needs no GraphQL at all. `splitRiotTeamId` was written for the composite form and has
> since been deleted, since nothing will ever emit one.

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
- **Forward pagination works, verified (Stage 0.7).** `fetchMatches` crawls `data.schedule.pages.newer`
  via `pageToken` to exhaustion — see the Pagination section above and
  `fixtures/riot-lol/rest_getSchedule_crawl_2026-08-12/`. `capabilities.timeWindow` stays `false`
  regardless: the adapter uses the cursor to fetch the whole forward horizon, not to narrow to a
  requested range, which is the opposite of what that flag means.
- **Historical backfill is a separate, still-open question.** It needs the `older` direction, which
  a 6-page backward probe did not terminate (see Pagination above) — so unlike the forward
  direction, this is not yet "plausible with an unmeasured page count", it is unmeasured whether it
  terminates at all. A 3-page re-check on 2026-08-12 reconfirms only what it set out to: the pages are
  contiguous and the direction works, and `pages.older` is still non-null at page 3 — the scope was
  explicitly "does it work", not "how far", so this does not move the 6-page/480-event/`2026-07-19`
  figure. *Basis: measured, this run, n=2 pages, probes `older-walk-2`/`older-walk-3` in
  `docs/sources/riot-rest-parameters.md`.*
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

`status` values as first recorded:

| Value | Leagues |
|---|---|
| `force_selected` | Worlds, MSI, First Stand |
| `selected` / `not_selected` | everything current |
| `hidden` | LTA North/South/Cross, LLA, LCO, LCL, WQS, King's Duel |

### Correction: what `displayPriority.status` means — 2026-08-09

*Confidence: **a single human observation of lolesports.com, with no artifact.** No screenshot, no
captured HTML, no fixture, no test. It supersedes an earlier reading that was inferred from the field
name and never checked at all, so it is an improvement — but it is one person looking once at a page
that will change, and it cannot be re-verified from this repo. Read the qualification below before
relying on it.*

The earlier note said `selected` / `not_selected` was "the default checkbox state" of the site's league
filter. That is wrong. **KeSPA Cup is `not_selected`, and it does not appear in the site's league
filter at all** — it is not an unticked box, it is absent.

The conclusion drawn was broader: `getLeagues` returns 45 leagues, the site displays fewer, and the
site applies a filter above the API that the API does not expose. Nothing in `displayPriority`
predicts whether a league is shown.

> **This observation is no longer load-bearing, and that is the point.** It was used to justify the
> existence of `config/leagues.json` and the whole tier gate — an unrepeatable glance at a web page
> holding up a core design decision. Since 2026-08-11 coverage is **the owner's product decision**
> (SPEC §1), which needs no evidence about Riot's website at all. The file's contents are now defended
> by "these are the eight leagues the owner wants", and the API measurements are only used for the
> narrower, reproducible claim they actually support: that a tier **cannot be derived** from
> `priority` (1 for all 45, exhaustive) or `displayPriority` (contradicted itself across two endpoints
> the same day, cross-checked). That narrower claim is all the design needs.
>
> The KeSPA Cup observation is retained because it is probably true and it explains why the counts
> differ, not because anything depends on it.

`hidden` still looks like a discontinued-league marker and still corroborates the 2026 restructure
(LTA dissolved; LCS and CBLOL reinstated), but after the above it is treated as a hint, not a
signal. Nothing in the code reads it.

### Consequence: maintain our own tier classification

Sync **all** leagues into the DB with a `tier` column (`major` / `minor` / `unclassified`). New
leagues default to `unclassified` and are surfaced for manual review rather than silently included
or dropped. Three leagues appeared in 2026 alone (EWC, CACG, FLS), so this needs a process, not a
hardcoded array.

`region` (`KOREA`, `CHINA`, `INTERNATIONAL`, `EMEA`, …) is a usable free grouping for the UI.

### `tft_esports` is in the league list

TFT is a different game. Multi-title support is required by the **first** source, not deferred to
VALORANT. Useful validation target for the Stage 0 interface.

## `getTeams` — the team master table

*Probed and captured 2026-08-09T15:10Z. `fixtures/riot-lol/rest_getTeams.json` + sidecar.*

```
GET /persisted/gw/getTeams?hl=en-US
data.teams[]  id, slug, name, code, image, alternativeImage, backgroundImage,
              status, homeLeague { name, region }, players[]
```

> **Correction, 2026-08-12: "no other parameters" was never probed, and it is wrong.** This line
> read "no other parameters; returns everything" — an assumption in the declarative voice, not a
> measurement, and exactly the failure mode this file's own preamble apologises for twice elsewhere.
> `getTeams?id=<teamId>` narrows cleanly to the single requested team (477 bytes / 1 row against the
> 1540971-byte / 1568-row unparameterised anchor, same run). *Basis: measured, n=1, probe
> `teams-id-filter` in `docs/sources/riot-rest-parameters.md`.* Unparameterised `getTeams` still
> returns the whole table when `id` is omitted, and there is still no pagination (`data.pages` is
> absent from the response entirely) — that much of the original claim holds.

**1568 teams**, 1542967 bytes. `status`: 1176 `active`, 392 `archived`. No other status value appears
— *exhaustive over this one capture*, which is why the parser warns on a third value rather than
throwing.

> ### ⚠ Read this before quoting any number in this section
>
> **Every figure below was measured against the full 1568-row response, which is not in version
> control** (1.5 MB; `.gitignore`d by name). The committed fixture `rest_getTeams.json` is trimmed to
> **71 rows** and cannot reproduce any of the counts — not 1568, not 1176, not 46, not the narrowed
> total, not 486, not 1358. The tests do not assert them, and say so where they touch the subject.
>
> So "exhaustive" below means *exhaustive over a capture the reader cannot open*. That is a weaker
> claim than the word suggests, and it is the one place this repo's own rule — encode an upgraded claim
> as a test, not only as a paragraph — is not met.
>
> What has been fixed is the reproducibility rather than the wording: `npm run capture -- getTeams
> <path>` re-fetches the full response with a sidecar, so the measurements can be re-derived instead
> of trusted. `fixtures/riot-lol/rest_getTeams.meta.json` carries the exact command.

### It resolves open question 2 — verified

`getTeams` ids are the same ids `getEventDetails` returns:

| Team | getTeams | getEventDetails | GraphQL composite suffix |
|---|---|---|---|
| Suzhou LNG Esports | `99566404850008779` | `99566404850008779` | `99566404850008779` |
| Invictus Gaming | `99566404848691211` | `99566404848691211` | — |

Three endpoints agree on the same id, and one unparameterised call builds the whole crosswalk.
**This is what removed GraphQL from the roadmap**: the persisted-query hash was only ever needed for
team ids and correct state, and REST supplies the first outright and the second by inference from
`result`.

*Confidence: cross-checked across three endpoints, **n = 2 teams** (one of them across only two
endpoints). Strong enough to build on — nothing plausible explains three endpoints agreeing except
these being the real ids — but it is a four-cell table, not a survey, and the sidecar's flat
`"identityOfIds": "verified"` overstates it.*

### The join is by name, with code as a fallback — corrected 2026-08-11

`getSchedule` gives a team `name` and `code`; `getTeams` gives both plus `id`. Joining them is the whole
mechanism.

> **This section originally joined on `code` and never evaluated `name`.** Its opening line dismissed
> the two together — "teams carry only `name` and `code`, both unstable (renames; codes collide across
> leagues — TL, KC, FX all recur)" — noticed that codes collide, chose codes anyway, and built two
> layers of narrowing plus a tier gate to compensate. Measured properly, name wins on every axis:
>
> | candidate set | by name | by code |
> |---|---|---|
> | all 1176 active rows | **15** collisions | 46 collisions |
> | narrowed to covered regional leagues (168 rows) | **0** collisions | 1 collision (EG) |
> | the 60 covered sides in `rest_getSchedule.json` | 60 unique, 0 missed | 60 unique, 0 missed |
>
> **The decisive finding is not the count, it is that a code names the organisation rather than the
> squad.** All seven LCK orgs that field an academy share a code between the pair and share no name:
>
> | code | first team | academy |
> |---|---|---|
> | `KT` | kt Rolster | kt Challengers |
> | `DK` | Dplus KIA | DK Challengers |
> | `HLE` | Hanwha Life Esports | HLE Challengers |
> | `BFX` | BNK FEARX | BNK FEARX Youth |
> | `NS` | NONGSHIM RED FORCE | NS Challengers |
> | `KRX` | KIWOOM DRX | KRX Challengers |
> | `DNS` | DN SOOPers | DNS Challengers |
>
> Under a code join, an academy side resolves to its parent's id — which is why the tier gate had to
> exist. Under a name join the academy is simply not in a narrowed table, so the lookup misses and
> warns. The gate is now a scope decision, not the safety mechanism.
>
> *Confidence: exhaustive over the full 2026-08-09 capture for the collision counts (not reproducible
> from the committed fixture); exhaustive over the committed fixture for the 60/60 name match and for
> the seven academy pairs, both asserted as tests.*
>
> **Locale stability, strengthened 2026-08-12.** The 60/60 name match above was measured across two
> fixtures captured **three days apart**, under different `hl` values (`rest_getSchedule.json` at
> `hl=zh-TW`, `rest_getTeams.json` at `hl=en-US`). Stage 0.8 ran the same question same-instant, at
> full scale: `getTeams` under `hl=zh-TW` compared against a same-run `hl=en-US` anchor, **all 1568
> teams, zero name mismatches**. This was the single highest-stakes probe of that stage — a mismatch
> would have invalidated the join key outright — and it confirmed rather than falsified the premise.
> *Basis: measured, this run, n=1568, probe `teams-hl-zh-tw` in `docs/sources/riot-rest-parameters.md`.*
>
> **Two caveats, both measured.** Six active rows carry trailing whitespace in `name` (`"Suning "`,
> `"TT willhaben "`, …), so the key is trimmed and lower-cased — which introduces zero additional
> collisions. And `code` is kept as a fallback for a rename that has reached one endpoint and not the
> other; a fallback hit raises `team-name-mismatch`, which is notice before the next rebrand misses
> outright.
>
> **One thing that could not be verified.** EG appears in neither committed schedule capture, so
> whether `getSchedule` writes `"Evil Geniuses LG"` or bare `"Evil Geniuses"` is unknown. `getTeams`
> has `"Evil Geniuses LG"` (LCS) and `"Evil Geniuses EU"` (LEC) as distinct names, so if the schedule
> agrees, the manual override is unnecessary; if it writes the bare name, the code fallback and the
> override handle it. Both overrides are retained precisely because this is unknown.

The counts below are the ones that motivated narrowing in the first place, and they still hold:

*Confidence: exhaustive over the 2026-08-09 capture — all 1568 rows classified, not sampled — but see
the warning above: the capture is not committed, so this is not reproducible from the repo.*

> **Correction, 2026-08-11.** This table read "**27** — nearly all a first team and its own
> Challengers/Academy squad" for the all-active row. Both halves were wrong. Re-measured: **46** codes
> collide among the 1176 active rows, and 27 is the count of collisions that involve an academy squad —
> the right descriptive clause attached to the wrong denominator. 27 of 46 is "most", not "nearly all".
>
> The number was wrong for two days and nobody noticed, because nothing could check it: the response it
> was measured on is not in version control, and no test asserts it. It was caught only incidentally,
> while measuring `name` against `code` for the join-key decision. **This is the concrete cost of the
> reproducibility gap the box above describes** — not a hypothetical.

| Candidate set | Rows | Codes claimed more than once |
|---|---|---|
| all active teams | 1176 | **46** — of which 27 are a first team and its own Challengers/Academy/Youth squad (DK, BFX, HLE, KT, …) |
| all active teams **with a home league** | 690 | 16 |
| active ∧ home league covered, **14-league coverage** (until 2026-08-11) | 290 | 1 |
| active ∧ home league covered, **8-league coverage** (current) | **175** | **1** |
| active ∧ home league a covered **regional** league (what the code actually uses) | **168** across 167 codes | **1** |

The survivor is `EG`: Evil Geniuses LG (`103461966951059521`, LCS) and Evil Geniuses EU
(`109218871531830908`, LEC). Both are first teams in covered leagues, so no automatic rule separates
them — it takes a manual override, and **this** override lives in `config/leagues.json`, keyed on
`(code, the league slug of the match)`. An earlier draft said "which is what
`external_ref.manualOverride` is for", conflating two different mechanisms: a code-disambiguation rule
the adapter applies at parse time, and a flag marking a crosswalk row as hand-set so sync will not
re-derive it. The adapter has no database, so its rule cannot live in a table. Both exist for good
reasons — see SPEC §5.

### Covered ≠ contributes teams — and narrowing to eight is what exposed it

The last two rows of that table differ by seven, and the seven matter. Restricting to covered leagues
naively includes the three international events, and `getTeams` homes seven **active** rows at Worlds
and MSI, none of which is a team that plays:

| Code | Id | Name | homeLeague |
|---|---|---|---|
| `EPIK` | 107125045186188951 | EPIK Gamer | Worlds |
| `GDEE` | 107125058951160151 | Team GAMED.DE | Worlds |
| `AAA` | 107125070345408946 | against All authority | Worlds |
| `PCFC` | 107125080370975157 | Pacific eSports | Worlds |
| `XAN` | 107125087138652506 | Xan | Worlds |
| `LCS` | 108183932728352967 | **LCS** | MSI |
| `VCS` | 108183935550202058 | **VCS** | MSI |

Five are 2011-era orgs; two are region placeholder entities carrying `LCS` and `VCS` as codes. No
collision results *today*, which is exactly why this needed measuring rather than assuming.

So an international event must have its **matches** resolved — a Worlds match has to resolve T1 — while
never **defining** who the teams are. Two sets, not one: `majorSlugs()` gates resolution,
`teamHomeLeagueSlugs()` narrows the table. This was invisible while all fourteen covered leagues
happened to be regional; narrowing to eight surfaced it, and `LeagueKind` now makes it explicit and
required.

*Confidence: exhaustive over the full 2026-08-09 capture for the seven rows and the counts (not
reproducible from the committed fixture — the only event-homed row in the 71-row trim is archived). The
narrowing **rule** is asserted on synthetic records in `tests/riot-team-identity.test.ts`, which is the
half a test can hold.*

**Narrowing the table is necessary and not sufficient.** Resolution must also be gated on the tier
of the league the *match* is played under. Second teams carry their parent's code, so an
`lck_challengers_league` match asking for "KT" finds `kt Rolster` in a table that quite correctly
contains only first teams. Measured: **11 sides in `rest_getSchedule.json` would be given the wrong
LCK org's id** if the gate were absent — "kt Challengers" → kt Rolster, "DK Challengers" → Dplus
KIA, and so on. A wrong identity looks exactly like a right one, which is worse than a missing one.

### `homeLeague` is a localized display name and nothing else

`{name, region}` — no slug, no id, and `region` is demonstrably translated (`KOREA` / `韓國`). All
38 distinct `homeLeague.name` values match a `getLeagues.name` exactly, so the join from a league
slug to the team table runs slug → `getLeagues.name` → `homeLeague.name`.

That makes **`hl=en-US` load-bearing for identity, not just for display**. Mixing locales across
the two requests would silently produce an empty team table rather than an error. It is the second
independent argument for the pin, after `blockName` and `tournament.name` being translated.

### Corrections to earlier assumptions

- **`image` is not https.** 1358 of the 1568 rows, and 153 of the 168 in the narrowed table, are
  `http://` (it was 271 of 290 under the fourteen-league coverage; in the committed 71-row fixture it
  is 47 of 47). The `getTeams` asset is usually newer than the one in `getSchedule` and is preferred
  for that reason, but it does not solve mixed content and the rewrite still runs over it.
- **`status: "active"` is not a currency signal.** LCK has 70 active rows against ten real teams;
  the master table keeps historical orgs listed. This is harmless: the table is allowed to be
  dirty as long as it does not collide.
- **486 of the 1176 active rows have `homeLeague: null`** — academy squads and regional teams.
  They cannot be narrowed and so are excluded outright.

### `players`

Every team carries a full roster. SPEC excludes player data, so the field is not declared in the
DTO — zod strips it at the wire boundary rather than leaving it to be dropped downstream — and it
is removed from the committed fixture under the personal-data exception in `fixtures/README.md`.

## Endpoint-specific notes

**`getEventDetails?id=<matchId>`** — enrichment only. Returns team ids, `league.id`,
`tournament.id`, and `games[].teams[].side` (blue/red). Does **not** return `startTime`, `state`,
or `blockName`, so it cannot back a calendar on its own. **Two boundary facts, added 2026-08-12:**
a comma-joined `id` list is rejected outright (HTTP 400) — no batching, and it does not silently use
only the first id, an assumption this file never actually tested before. An id that cannot exist
returns **HTTP 200 with `data.event: null`** — not the `{"errors": [...]}` envelope `client.ts`
checks for. Since nothing in `src/` calls this endpoint today it is not a live bug, but wiring it up
later needs an explicit null check, not just the existing error-envelope guard. Also carries a
`streams` key: empty for both probed matches so far (one unstarted, one completed — n=2, still zero
evidence either way). *Basis: measured, this run, n=1 each, probes `event-details-two-ids`,
`event-details-bogus`, `event-details-by-id` in `docs/sources/riot-rest-parameters.md`.*

**`getLive`** — returned `{"events": []}` when probed on 2026-08-09, and again on 2026-08-12
(probe `live`, n=2 now, both empty, both off-hours). Still inconclusive, not evidence that streams
are absent. Re-probe during an actual broadcast.

## Open questions

1. ~~**Do stream links ever appear?**~~ **Closed, as a decision rather than a discovery.** The
   evidence is unchanged and still inconclusive: `getSchedule` has no `streams` key anywhere
   (exhaustive over the capture), `getEventDetails` returned `[]` for an unstarted match (n = 1), and
   `getLive` was empty because nothing was live (inconclusive, not negative). What changed is that we
   stopped waiting: `capabilities.streamUrls: false` is Riot's settled answer, FR-4 falls back to a
   hand-maintained `league.default_stream_url` plus a hand-maintained co-stream list, and there is no
   pre-broadcast fetch path in the architecture. This entry previously read "Still unresolved… Blocks
   FR-4", which contradicted `lolesports.md` and `src/core/source.ts`, both of which had already
   recorded the decision. Re-probing `getLive` during a broadcast would be interesting and would
   change nothing.
2. ~~Does `getTeams` return the same team ids as `getEventDetails`?~~ **Answered 2026-08-09: yes.**
   It takes no parameters, returns all 1568 teams, and its ids match `getEventDetails` exactly. See
   the `getTeams` section above. It is the cheap bulk path, and it is what made the GraphQL adapter
   unnecessary.
3. **What is the relationship between `lcs` and `lta_n` / `lta_s` / `lta_cross`?** All four are in
   `getLeagues`. `lcs` had four matches in the 2026-08-09 window; the three LTA slugs had none, and
   the `hidden` table above lists LTA as discontinued. `lcs` is the covered slug on that basis, which
   is thin. Needs a wider capture than one five-day window to settle. Tracked in SPEC §9.

## Also captured: `getSchedule?leagueId=<id>`

*Verified 2026-08-09, and corrected 2026-08-12 — see below.* `getSchedule` accepts a `leagueId`.
For `ewc_lol` it returned 28 events in one page, both `pages` cursors `null`, every event carrying
`league.slug: "ewc_lol"`. It is how `rest_getSchedule_ewc.json` was captured: the unparameterised
window contained no team playing outside its own home league, so cross-league resolution had
nothing to test against.

> **Correction, 2026-08-12: `leagueId` is not a single-page endpoint — it generalised from too
> small a league.** This section originally said a `leagueId` call "returns that league's full
> history in one page". `lck`'s history does not fit in one: `leagueId=98767991310872058` returned
> 80 events (the same page size as the unparameterised call) with `pages.newer: null` but
> **`pages.older` non-null** — a genuinely paginated result, not a single page. `ewc_lol`'s 28
> events simply fit inside the 80-event page, which made a page-limited endpoint look unlimited.
> Cross-checked: the 80 LCK events agree exactly with the equivalent slice of the global forward
> crawl over their overlapping range (zero events in the set difference either way). See the
> Pagination section above for the full measurement.

> **`ewc_lol` left coverage on 2026-08-11**, so this fixture no longer exercises the path it was
> captured for. It was not deleted: the test built on it now asserts the *opposite* behaviour — that a
> league we stopped covering still yields matches and team names, just no resolved ids — which is the
> assertion that decides whether narrowing coverage is safe. Cross-league resolution moved to a
> synthetic `worlds` event, since `worlds` is covered and is a path production actually takes. EWC is
> the most likely first readmission, and this is the block that flips if it returns.
