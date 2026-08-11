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

## Endpoint

- **Base**: `https://esports-api.lolesports.com/persisted/gw/`
- **Auth**: a static `x-api-key` that the site ships to every browser. Value in `.env.example` and
  read from `RIOT_ESPORTS_API_KEY`; it is deliberately not repeated here, because the fixture sidecars
  redact it and having it in three places made the redaction meaningless.
  *Confidence: it worked unchanged across every probe on 2026-08-09. Nothing here establishes how long
  it has been stable — "unchanged for years" was asserted in an earlier draft with no evidence and is
  withdrawn. The client treats a 4xx as final precisely so a rotated key fails loudly.*
- **Locale**: `hl=en-US`. Use en-US as the canonical identity locale for the whole system.
- **Pagination**: `data.schedule.pages.{older,newer}` return non-null base64 cursors on an
  unparameterised `getSchedule` call, and both are null on the `leagueId`-scoped capture used for
  `rest_getSchedule_ewc.json` (consistent with that call returning a single page). **What is not
  known: the query parameter name a cursor is sent back as.** It has never been recorded or probed
  anywhere in this repo. An earlier version of this line said "real, working", which stated a
  request nobody has made as a fact about a field that is merely present and non-null.
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
- **Historical backfill, plausibly** — its `pages.{older,newer}` cursors are non-null on an
  unparameterised call (the GraphQL ones were null even there), which is evidence the endpoint is
  paginated. It is not evidence that backfill *works*: the query parameter a cursor is sent back as
  has never been recorded or tried. Downgraded from an earlier "actually work" — see the Pagination
  line above and `src/sources/riot/rest/adapter.ts`'s `timeWindow` comment for the same correction.
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
GET /persisted/gw/getTeams?hl=en-US        -- no other parameters; returns everything
data.teams[]  id, slug, name, code, image, alternativeImage, backgroundImage,
              status, homeLeague { name, region }, players[]
```

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
or `blockName`, so it cannot back a calendar on its own.

**`getLive`** — returned `{"events": []}` when probed; no matches were live at the time. This is
an inconclusive result, not evidence that streams are absent. Re-probe during an actual broadcast.

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

*Verified 2026-08-09.* `getSchedule` accepts a `leagueId` and returns that league's full history in
one page — 28 events for `ewc_lol`, both `pages` cursors `null`, every event carrying
`league.slug: "ewc_lol"`. The unparameterised call returns a ~5-day window around now; this one
does not. Useful for backfill, and it is how `rest_getSchedule_ewc.json` was captured: the
unparameterised window contained no team playing outside its own home league, so cross-league
resolution had nothing to test against.

> **`ewc_lol` left coverage on 2026-08-11**, so this fixture no longer exercises the path it was
> captured for. It was not deleted: the test built on it now asserts the *opposite* behaviour — that a
> league we stopped covering still yields matches and team names, just no resolved ids — which is the
> assertion that decides whether narrowing coverage is safe. Cross-league resolution moved to a
> synthetic `worlds` event, since `worlds` is covered and is a path production actually takes. EWC is
> the most likely first readmission, and this is the block that flips if it returns.
