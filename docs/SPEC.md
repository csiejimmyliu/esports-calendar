# Esports Calendar — Product & Architecture Spec

> Source of truth. Claude Code reads this before planning any stage.
> If reality diverges from this document, update the document. Do not let code and spec drift.

> **Provenance, 2026-08-11.** Sections 0–2 and 8 were rewritten from the owner's own statement of
> requirements. Everything before that revision had been extrapolated by a model from a verbal
> sketch and never reviewed line by line, and three things in it were simply wrong about the
> product: the calendar was defined as the union of subscriptions with no way to pick individual
> matches, there was no distinction between browsing and following, and the native iOS app — the
> delivery the owner most wants — was scheduled second to last. Where a claim below is inherited
> from that earlier draft rather than confirmed, it says so.

---

## 0. One-line definition

A **League of Legends esports match calendar**. There are two surfaces:

- an **overview** of every match we cover, filterable by league and by team, and
- a **personal calendar** containing only the matches the user chose.

A user gets matches onto the calendar two ways, and both are live at once: **following** a league or
a team so its matches arrive automatically, and **picking** an individual match by hand. Following
sets a default; the user can still drop single matches from the calendar without unfollowing.

Later: reminders, and a stream link per match with a user-defined provider order.

### Scope decision, 2026-08-09: LoL only

VALORANT and CS2 adapters are off the roadmap. Other titles are considered once the LoL calendar is
complete, which is the owner's stated sequence, not a euphemism for never.

**The cross-title design is kept and paid for; only the implementation is deferred.** Three real
sources were probed before the interface was written, and what they forced stays in:
`SourceCapabilities`, the `game` field on the domain types, the optional `league`, the two-phase
`listScopes` → `fetchMatches` shape, and the four notes in `docs/sources/`. What is retained has no
consumer today and is marked as such in the code — see the comment on `GameSlug` in
`src/core/types.ts`, which names every retained artefact and why it is there.

`docs/sources/valorant.md` and `docs/sources/cs2-blast.md` are retained as findings, not as pending
work. For the record: VALORANT shares Riot's backend — same key, same envelope, one path segment
apart (`/persisted/val/` vs `/persisted/gw/`) — so cheap multi-title validation is an hour of work
rather than a session.

---

## 1. Scope

### Coverage: eight leagues

Decided by the owner, 2026-08-11. These are Riot's own slugs, all eight verified present in the
2026-08-09 `getLeagues` capture:

| | Slugs |
|---|---|
| International events | `worlds`, `msi`, `first_stand` |
| Regional leagues | `lck`, `lpl`, `lec`, `lcs`, `lcp` |

Everything else Riot returns — 37 further leagues, including every second-team and tier-2 competition
— is out of coverage. This is a **product decision**, recorded in `config/leagues.json` with a reason
per exclusion. It is expected to change: the owner intends a proper study of the full league list
before widening it, and `ewc_lol` in particular is a plausible readmission.

Two consequences that are easy to get wrong:

1. **Out of coverage does not mean discarded.** An uncovered league's matches are still parsed and
   still carry team *names*; what they lack is resolved team *identity*, so they cannot back a team
   follow. Narrowing coverage must never lose matches.
2. **Coverage gates two different sets.** See §5 on identity — the leagues whose matches we resolve
   and the leagues that define who the teams are are not the same list.

### In scope

| Area | Decision |
|---|---|
| Titles | **LoL only.** The abstraction that would carry a second title is built and kept (§0). |
| Coverage | The eight leagues above. Hand-maintained in `config/leagues.json`; not derivable from the API (§4). |
| Match unit | **A series is one match.** A Bo3 or Bo5 is a single calendar entry, never three or five. |
| Per-match data | Teams, league, scheduled start. That is the whole requirement. |
| Overview | Every covered match, filterable by league and team. Follow and pick actions live here. |
| Calendar | The user's own matches only. |
| Past matches | **In scope.** The overview shows completed matches; scores are hidden by default. |
| Subscription | Follow a league or a team, plus per-match include/exclude overrides. |
| Delivery | Web (overview + calendar) → ICS export → native iOS app. API-first throughout. |
| Streams | Default official English broadcast; user-defined provider order per league and per team. |
| Notifications | Default 30 min before + at scheduled start. User-configurable lead time. |
| Accounts | **Anonymous first.** Full use without an account; signing in migrates the data. |
| Auth | Google OAuth. |
| Licensing | **Open source.** Data sources attributed. |

### Explicitly out of scope

Player data, coach data, rosters, transfers, contracts. Live scoring, live match state, in-progress
badges. Match statistics, picks/bans, VODs. Standings and brackets. Betting, predictions, social
features.

The absence of player data is enforced in code, not merely documented: `players` is undeclared in the
`getTeams` zod schema, so rosters are stripped at the adapter boundary, and the committed fixture
contains no player names. Two tests assert both halves.

### The consequence of dropping "live"

Notifications fire on the **scheduled** time, not on the actual broadcast start. A match that starts
20 minutes late produces an early notification. This is accepted.

In exchange: sync can run hourly rather than continuously, cache TTLs can be long, and there is no
traffic spike concentrated on a single match. This removes the largest source of complexity in the
system.

### The one data gap this scope has, and nobody had decided it

**Riot supplies no end time and no duration.** `getSchedule` carries `startTime` and nothing else
temporal — verified exhaustively over the 2026-08-09 capture. But a calendar entry needs an end:
ICS requires `DTEND`, and so does any week or month view.

Decision: **estimate at the render boundary from `seriesLength`, and never store the estimate as if
it were data.** `match.starts_at_utc` is the only persisted instant.

| Series | Rendered duration |
|---|---|
| Bo1 | 60 min |
| Bo3 | 3 h |
| Bo5 | 5 h |

Approved by the owner 2026-08-11. These are **judgement, not measurement** — no broadcast length has
been measured, and measuring one would need data this project deliberately does not collect. Label them
as estimates wherever they are written down, and expect a long series to overrun its block.

Persisting a fabricated `ends_at_utc` would launder the guess into the data model, where the next
reader could not tell it from a measurement.

---

## 2. Functional requirements

### FR-1 Following, and per-match overrides

This replaces the earlier "visible set is the union of subscriptions". That model cannot express what
the product does, because it has no way to say "follow T1 but not this one match".

Two pieces of user state:

```
follow(user, target_type ∈ {league, team}, target_id)
selection(user, match, state ∈ {included, excluded})
```

And the calendar is:

```
calendar(user) = { m | (derived(u, m) ∨ included(u, m)) ∧ ¬excluded(u, m) }

derived(u, m)  ⟺  ∃ f ∈ follow(u) : f.target is m.league, or f.target is a team on either side of m
```

**It is still a pure function**, which the earlier draft's acceptance criterion required and which
survives: the inputs are (follows, selections, matches) instead of (subscriptions, matches). Signature
changed, nature did not. Table-driven tests still apply and are still the acceptance criterion.

The rules that are not obvious, each of which needs a named test:

1. **An explicit action always beats a derived one.** `excluded` removes a match that a follow would
   have added; `included` adds one no follow covers.
2. **`selection` is one row per (user, match)**, with a state — not two tables. Excluding a match the
   user had previously picked replaces the row. Two tables would allow a contradictory pair.
3. **Unfollowing does not delete picks.** Unfollow T1 and the T1 matches you picked by hand stay;
   only derived membership goes away. The user said something explicit about those matches.
4. **`excluded` rows are kept after the match has finished.** Deleting them would silently rewrite
   the user's past calendar.
5. **An `excluded` row for a match nothing derives is inert, and is kept anyway.** Re-following the
   team must restore the user's earlier intent, not resurrect a match they had removed.
6. **Overrides key on `match_id`, never on time.** So a rescheduled match carries its selection
   automatically, with no fixup pass. Same argument as the notification sweeper in §6.
7. **TBD opponents resolve into the calendar by themselves.** Following T1 does not surface a Worlds
   match with undecided sides; when Riot fills the side in, the match becomes derived and appears.
   No user action, no backfill job.

Anonymous users hold both tables against a device-scoped identity. Signing in migrates follows *and*
selections into the account without duplicating them.

### FR-2 Two surfaces, and filtering is not following

**Overview.** Every covered match, past and future. Filterable by league and by team. This is where
the user follows a league, follows a team, or picks a single match.

**Calendar.** Only `calendar(user)` from FR-1. Agenda (chronological, default), week, month. "Today"
reachable in one interaction.

**A filter is a view state; a follow is stored data.** Filtering the overview to LCK must not follow
LCK, and must not change the calendar. This distinction is easy to blur in a UI — a "show only LCK"
control sitting next to a "follow LCK" control — and blurring it makes the product's central
behaviour unpredictable. It gets an explicit test at the API level: applying a filter issues no
write.

### FR-3 Spoiler-free mode

Default ON. Completed matches show teams and time but not score or winner until explicitly revealed.
Applies to ICS `SUMMARY` as well — never put a score in it.

Past matches are in scope (§1), so this is load-bearing rather than theoretical: the overview shows
finished matches by default and must not reveal their results by default. Scores are stored; they are
simply not rendered unless asked for.

### FR-4 Stream resolution

First match wins:

1. User preference scoped to the **team**
2. User preference scoped to the **league**
3. User's global preferred provider + locale
4. Source-provided official stream for the user's locale
5. Source-provided default stream

A preference is `(provider, channel)` — e.g. `(twitch, "lck")`. Links out; no embedded player.

This ladder matches the requirement as stated ("default the official English broadcast, but let me
put Caedrel first for LCK"). One fact it depends on, and it is unwelcome:

**Riot supplies no stream URLs at all.** Verified: there is no `streams` key anywhere in the
`getSchedule` document, and `riot-rest-lol` declares `capabilities.streamUrls: false` as a settled
answer rather than a pending probe. So steps 4 and 5 have no source data for LoL, and the entire
ladder rests on hand-maintained values: `league.default_stream_url` for the official broadcast, and a
hand-maintained channel list for co-streams like Caedrel's. That is a data-entry obligation, not an
implementation task, and it should be sized as one.

### FR-5 ICS export

Per-user URL with an unguessable token (not the user id). Stable `UID` per match. `SEQUENCE`
increments when a user-visible field changes. `VALARM` carries the reminder. Same selection set and
spoiler rules as the web UI. `DTEND` uses the estimated duration from §1, which means an ICS event's
length is a guess and should not be presented as authoritative.

Wanted, but **not urgent** — the owner's words. It is an export of a calendar the user assembled
elsewhere, so it necessarily follows the surfaces in FR-2. Its payoff is real though: once it exists,
the user's own calendar app provides reminders, which may change how much self-hosted push is worth
building.

### FR-6 Notifications

- Defaults: 30 minutes before, and at scheduled start.
- Lead time user-configurable; either notification independently disableable.
- Channels are pluggable. First: Web Push. Then APNs for native iOS. ICS `VALARM` gets it free.
- A rescheduled match must not fire a notification at the stale time.

---

## 3. Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-1 | **API-first.** Every capability is available over JSON API. No web-only logic — the iOS app must be able to do everything the web can. |
| NFR-2 | **Source isolation.** User requests never trigger an upstream fetch. Only the sync worker calls upstream. |
| NFR-3 | **Source independence.** No source's identifiers, response shapes, or URLs leak above the adapter boundary. |
| NFR-4 | **Partial failure isolation.** One broken source, or one broken league within a source, must not fail the sync run or empty the calendar for the rest. |
| NFR-5 | **Visible staleness.** Per-source freshness is queryable and surfaced in the UI when stale. Never silently show an empty calendar. |
| NFR-6 | Stateless web tier. No session or user state in process memory. |
| NFR-7 | UTC in storage; timezone conversion only at render. |
| NFR-8 | **A user's explicit selection is never overwritten by sync.** Ingestion may add, update or cancel matches; it may not touch a `selection` row. |

---

## 4. Data sources

### Strategy

Sources are **self-built adapters against official event sites**, one per source, normalized into a
common domain model. There is no single upstream vendor.

Rationale: coverage is limited to eight leagues, so the number of sources is bounded and small. Each
adapter extracts only five fields per match (time, teams, format, state, streams), which is shallow
enough to be robust.

### The unit of a source is an ORGANIZER, not a title

LoL and VALORANT each have one official Riot-run site. **CS2 does not** — its major events are run by
separate organizers (ESL, BLAST, PGL), each with its own site. Dota 2 is similar post-DPC.

Therefore: one title may have many sources; one source may span titles. The schema models `source` as
a first-class entity, not as a column on `game`.

### Probed sources — see docs/sources/ for full notes

| Source | Game | Global schedule? | League tier? | Explicit state? | Stream URLs? | Status |
|---|---|---|---|---|---|---|
| Riot REST (`esports-api…/persisted/gw`) | LoL | yes | **no** | no — derived from `result` | no | **implemented** |
| Riot GraphQL (`lolesports.com/api/gql`) | LoL | yes | **no** | yes (`match.state`) | no | dropped |
| Riot REST (`…/persisted/val`) | VALORANT | yes | **no** | yes | no | deferred (§0) |
| BLAST (`api.blast.tv/v2`) | CS2 | **no** | **no** | **no** | **yes** | deferred (§0) |

Riot's LoL and VALORANT share one backend; the title is chosen by the path segment
`/persisted/{gw|val}/`. The domain is an alias and the `sport` query parameter is ignored.

**`riot-rest-lol` is the only source, and GraphQL is dropped.** GraphQL was originally the intended
primary, for two reasons: it carries team ids and a trustworthy `match.state`. Both reasons were then
removed. `getTeams` supplies team ids outright, and `result == null` determines state exactly — 7 of
7 unplayed matches and 0 of 73 played ones over the 2026-08-09 capture, encoded as a test. What
remains of GraphQL is a persisted-query hash tied to a frontend build that this repo never recorded,
which means `gql_homeEvents.json` cannot even be re-captured.

**No source exposes a usable league tier.** Riot's `priority` is `1` for all 45 LoL and 55 VALORANT
leagues, and `displayPriority` is per-request UI state — CACG returned `hidden` from one endpoint and
`selected` from another the same day, and LCK and LPL are `not_selected`. Both measured exhaustively
over one capture. Neither field is even read: they are undeclared in the zod schema and stripped.

So coverage is stated by hand in `config/leagues.json`. Note what changed here: an earlier version of
this section justified the file by an observation of the lolesports.com league picker, and that
justification is **withdrawn** — it was a single unrepeatable human observation with no artifact, and
it was never needed. The product's coverage does not require evidence about Riot's website; it
requires a decision by the owner, which §1 records. What the API measurements establish is only the
narrower claim that the tier *cannot be derived*, which is why the decision lives in a config file
rather than in code.

An explicit `minor` and an absent slug remain different states — absence means a league appeared
upstream after the file was last touched, and it warns. Three leagues appeared during 2026
(`ewc_lol`, `cacg`, `fls`); that is known from the season restructure rather than measured, since a
single-day capture cannot show change over time.

Sync every league Riot returns into the DB, with `tier` defaulting to `unclassified`, and surface new
ones for review.

### Consequences for the interface

**Fetching is two-phase.** BLAST has no global schedule endpoint — matches are only reachable at
`/tournaments/{slug}/matches`, so a scope must be known first. The interface enumerates scopes, then
fetches per scope; Riot returns a single global scope. Shaping to the weaker capability is deliberate.

> **Unreviewed finding, and it invalidates the sentence above for upcoming events.** For
> `esports-world-cup-2026-cs2`, whose event starts 2026-08-12, `/matches` returned HTTP 200 and `[]`
> while `/brackets` held the entire schedule, in the same minute. If that generalises, `/brackets` is
> not an enrichment — it is the only forward-looking source, and a BLAST adapter designed from the
> paragraph above alone would be wrong. Recorded here so a future attempt at §8 stage 11 does not
> have to rediscover it. See `docs/sources/cs2-blast.md`.

**Capabilities are declared, not assumed.** Sources differ in what they can do, not only in field
names. `SourceCapabilities` makes the sync layer branch honestly instead of discovering nulls at
runtime. A capability describes **what the adapter actually does**, not what the endpoint could
support: `riot-rest-lol` declares `timeWindow: false` even though, as of Stage 0.7,
`fetchMatches` sends a real cursor (`pageToken`, verified 2026-08-12 — see
`docs/sources/lolesports-rest.md`) — because it uses that cursor to crawl the whole forward horizon
to exhaustion, not to narrow to a requested range, which is the opposite of what the flag means. A
flag that overstates the code is worse than an absent one, because the sync layer branches on it.
There is a test pinning the flag to the behaviour.

**`league` is optional.** BLAST has `tournament → stage → match` only; its `circuit` is a year tag.

**`seriesLength` and `gamesPlayed` are separate.** A Bo3 ending 2-0 gives Riot three games with the
third `"unneeded"`, and BLAST an array of two. `seriesLength` is also what §1's duration estimate is
computed from.

**TBD is first-class.** Riot uses a sentinel (`code: "TBD"`, id suffix `:0`); BLAST uses `null`.
Detecting Riot's requires both the code *and* an absent `result`, because a real team that has not
played yet has `{gameWins: 0, outcome: null}` — present, and different.

**Stream URLs are a capability.** BLAST supplies per-match URLs; Riot supplies none, so LoL falls
back to a hand-maintained `league.default_stream_url` (FR-4).

### Agents: build-time only

An agent may be used to explore a new site, identify its endpoints, infer response shapes, and
**write the adapter**. This is the intended way to keep per-source cost low.

An agent must **never** be part of the runtime sync path. Agent output is code, not data. Runtime
parsing is deterministic, unit-tested, and runs in CI.

### The failure mode that matters

Scrapers rarely fail loudly. They return HTTP 200, valid JSON, and **zero rows**. Every health check
stays green while the calendar quietly empties.

**This is confirmed in the wild, not hypothetical.**
`GET /v2/games/cs/tournaments/NOT-A-REAL-SLUG/matches` returns HTTP 200 and `[]` — indistinguishable
from a real tournament with nothing scheduled yet. Typo one slug and that tournament silently
disappears from the calendar.

Two mandatory mitigations:

1. **Golden fixtures.** Every source's real response is snapshotted to disk. Parsers are tested
   against those fixtures in CI. An upstream shape change turns CI red immediately.
2. **Semantic canaries.** Scheduled assertions about *content*, not status codes.

**A canary must survive an off-season.** The earlier draft proposed "LCK has at least one match in the
next 14 days", and that shape is wrong for a seasonal sport: the three international majors have zero
matches for most of the year, measured directly against the 2026-08-09 capture, and regional leagues
have splits breaks. A canary that cries wolf on schedule gets muted, after which the next real outage
is silent — worse than having no canary. `riot-rest-lol` therefore asserts two things instead:

- **`regional-leagues-present`** — every covered *regional* league appears somewhere in the fetched
  window, past or future. `getSchedule` returns a window around now, so a quiet week still shows
  recently-played matches; total absence means the slug stopped matching. International events are
  excluded by construction.
- **`schedule-has-upcoming`** — at least one match, in any covered league, starts within 14 days.
  Deliberately not per-league, so it survives an off-season, and it catches a parse that yields only
  stale rows.

### Conduct

Polite polling with backoff. Identifying `User-Agent` with contact info. Cache aggressively; never
proxy user traffic upstream. Attribute sources. Since the repo is public, the adapters are visible —
keep the request volume defensible.

---

## 5. Domain model

```
game(id, slug, name)
source(id, slug, name, organizer, base_url, enabled)
source_health(source_id, last_success_at, last_failure_at, consecutive_failures,
              last_item_count, status)

league(id, game_id, slug, name, region, image_url,
       tier ENUM(major, minor, unclassified),
       kind ENUM(region, event) NULL,
       default_stream_url NULL)
tournament(id, league_id, name, starts_on, ends_on)
team(id, game_id, slug, name, code, image_url)

match(id, tournament_id NULL, league_id NULL, starts_at_utc, best_of, games_played,
      block_name, state, revision, updated_at)
match_team(match_id, team_id NULL, side, score NULL)
stream(match_id, provider, channel, locale, is_official)

external_ref(entity_type, entity_id, source_id, game_id, external_id, is_canonical,
             manual_override)

user(id, email NULL, created_at)
follow(user_id, target_type ENUM(league, team), target_id)
selection(user_id, match_id, state ENUM(included, excluded), updated_at)
stream_pref(user_id, scope ENUM(global, league, team), scope_id NULL, provider, channel, locale)
notification_rule(user_id, lead_minutes, enabled)
device(id, user_id, platform ENUM(web, ios), push_token)
ics_token(user_id, token, created_at)
sync_run(id, source_id, started_at, finished_at, item_count, status)
```

### Points worth defending in review

**`follow` + `selection`, not `subscription`.** The rename is not cosmetic. `subscription` carried the
implication that the calendar is derivable from it, and it is not (FR-1). Two tables with different
lifetimes: a follow is a standing rule, a selection is a statement about one match. NFR-8 protects
the latter from sync.

**`league.tier` and `league.kind`.** `tier` is ours to maintain because no source exposes one (§4).
`kind` exists because coverage gates two different sets, and they are not the same list:

- which matches have their teams **resolved** — all eight covered leagues, events included, because
  a Worlds match must resolve T1;
- which leagues **define** who the teams are — regional leagues only.

`getTeams` homes seven active rows at Worlds and MSI and not one is a team that plays: five are
2011-era orgs, and two are region placeholders literally named "LCS" and "VCS", carrying those codes.
Measured against the full 1568-row capture. This distinction was invisible while coverage happened to
be fourteen regional leagues; narrowing to eight exposed it, and `kind` is required on every covered
league so it cannot regress silently.

**`external_ref` is the identity layer.** Source ids are never primary keys. Keyed by
`(source_id, game_id, external_id)` — the game dimension is deliberate: Riot's LoL and VALORANT ids
appear to come from one generator, but that is unverified and one column buys the assumption out.

Team identity via Riot REST is a **narrowed join, not a lookup**. `getSchedule` names teams and
carries no team id anywhere (80 events, 80 ids, none a team's); `getTeams` is the master table.

**The join key is `name`, with `code` as a fallback.** The original design used `code` alone plus two
layers of narrowing to compensate, on the reasoning that both fields are "unstable" — the two were
never measured against each other. They have been now, against the full capture under the eight-league
coverage:

| candidate set | by name | by code |
|---|---|---|
| all 1176 active rows | 15 collisions | 46 collisions |
| narrowed to covered regional leagues (168 rows) | **0 collisions** | 1 collision (EG) |
| the 60 covered sides in the schedule capture | 60 unique, 0 missed | 60 unique, 0 missed |

The collision *count* is not the important part. **A code identifies the organisation, not the squad**,
so all seven LCK orgs that field an academy team share a code across the pair while sharing no name:
`kt Rolster`/`kt Challengers`, `Dplus KIA`/`DK Challengers`, `Hanwha Life Esports`/`HLE Challengers`,
`BNK FEARX`/`BNK FEARX Youth`, `NONGSHIM RED FORCE`/`NS Challengers`, `KIWOOM DRX`/`KRX Challengers`,
`DN SOOPers`/`DNS Challengers`. Under a code join an academy side resolves to its parent's id — a wrong
identity indistinguishable from a right one, and the reason a tier gate was needed at all. Under a name
join the academy is absent from the narrowed table, so the lookup misses. Safety by construction.

Names are locale-stable, which is the assumption that could have sunk this: the schedule capture is
`hl=zh-TW` and the team table `hl=en-US`, and all 60 names match byte for byte while `blockName` in the
same document is translated (`第11週`). Asserted as a test. Names are trimmed and lower-cased for the
lookup because six active rows carry trailing whitespace; measured, that adds zero collisions.

`code` is retained as a fallback for a rename that has reached one endpoint and not the other, and a
fallback hit raises `team-name-mismatch`: the identity is still right, and the disagreement is notice
before the next rebrand misses outright. A manual override can still settle a code collision.

Narrowing still matters. The tier gate on the league the match is played under also stays — but it is
now a **scope** decision (do not spend a lookup on a league we do not cover) rather than the safety
mechanism it was. An ambiguous match resolves to nothing and warns.

**Two override mechanisms, and the earlier draft conflated them.** It referred to
`external_ref.manualOverride` while its own schema block had no such column, and while the override
that actually works lives in `config/leagues.json`. They are different things and both belong:

| | `config/leagues.json` `teamOverrides` | `external_ref.manual_override` |
|---|---|---|
| Decides | which team an ambiguous **code** resolves to | that a **crosswalk row** was set by hand |
| Runs | at parse time, inside the adapter | at sync time, in the crosswalk |
| Keyed on | `(code, league slug of the match)` | `(entity, source, external_id)` |
| Exists | yes — the `EG` case, tested | no — stage 1 |
| Purpose | the adapter has no database and cannot look one up | stop sync re-deriving a human correction |

The config file is where a *coverage* decision goes, which is why the `EG` disambiguation lives there.
The column is what protects a hand-fixed identity from an hourly job, and renames and merges are normal
enough that a crosswalk with no manual escape hatch is a gap. Neither replaces the other.

**`source_health` is how NFR-5 is met.** Freshness has to be a queryable row, not a log line.

**`device` from day one.** Adding a push platform later is a migration; the column costs nothing now.

**`revision` drives ICS `SEQUENCE`.** Bumped only on user-visible change, so a calendar client is
told to update exactly when it should.

**`best_of` and `games_played` are separate columns.** §4 explains why, and §1's duration estimate
reads `best_of`.

**No `ends_at_utc`.** Deliberate — see §1. The only persisted instant is the scheduled start.

---

## 6. Architecture

```
                    ┌──────────── CDN ────────────┐
   browser ────────►│ static assets, team logos,   │
   iOS app ────────►│ global schedule snapshot     │
                    └──────────────┬───────────────┘
                                   │ miss
                          ┌────────▼────────┐
   calendar clients ─────►│  Load Balancer  │
   (ICS pollers)          └────────┬────────┘
                                   │
                       ┌───────────▼───────────┐
                       │  Web tier (stateless) │  N instances
                       │  JSON API + ICS       │
                       └───┬──────────────┬────┘
                           │              │
                     ┌─────▼─────┐  ┌─────▼──────┐
                     │  Redis    │  │ PostgreSQL │
                     └───────────┘  └─────▲──────┘
                                          │
              ┌───────────────────────────┴──────────────┐
              │  Sync worker — per-source, isolated       │
              │  ┌────────┐   ┌ ─ ─ ─ ─┐ ┌ ─ ─ ─ ─┐     │
              │  │ riot   │   │ riot   │ │ esl    │     │
              │  │ lol    │   │ valo   │ │ cs2    │     │
              │  └────────┘   └ ─ ─ ─ ─┘ └ ─ ─ ─ ─┘     │
              └────────────────────┬─────────────────────┘
                                   │ schedule-change events
                            ┌──────▼──────┐
                            │    Queue    │
                            └──────┬──────┘
                    ┌──────────────┴──────────────┐
                    │  Notification sweeper       │──► Web Push / APNs
                    └─────────────────────────────┘
```

Dashed workers are **deferred capabilities, not planned work** (§0). Only `riot lol` exists.

### Key design decision: the overview is a shared payload

The overview surface (FR-2) is the same for every user: every covered match, past and future. Filters
are applied per request, but the underlying data is identical. Only the follows and selections are
per-user, and they are tiny — a handful of ids plus a small set of match ids.

So: compute **one global snapshot**, version it, cache it, serve it from CDN. Apply filters and the
user's selection set at the edge or in the client. The read path barely touches the database, and ten
users or ten million hit the same cached object.

*Unmeasured.* The reasoning above assumes the snapshot is small — eight leagues, on the order of 10⁴
matches a year, and the 80-event capture serialises to 48 KB, so "well under a megabyte for a 30-day
window" is plausible arithmetic rather than a measurement. **No snapshot has been serialised.** Stage
8 measures it before stage 9 caches it, and if the number comes back different the conclusions in §7
change with it.

### ICS: the earlier cache key does not work

The earlier draft proposed:

```
cache_key = hash(sorted(subscription_set) + spoiler_flag + tz + snapshot_version)
```

on the reasoning that subscription sets cluster heavily, so the number of distinct feeds stays far
below the user count. **FR-1 breaks that.** Once every user can include and exclude individual
matches, each user's feed is almost certainly unique, and the key degrades to per-user with extra
steps.

The layering that does work separates the two halves by how shared they are:

- **The global snapshot is shared and cacheable**, aggressively, exactly as above. It is the
  expensive part and it is identical for everyone.
- **The selection set is per-user and tiny** — a list of match ids and override flags. Cache it per
  user with a short TTL, or not at all; it is one indexed read.
- **The ICS body is the composition**, and it is per-user. It is also cheap to build once the two
  inputs are in hand, so it is a render, not a query. Invalidate on `snapshot_version` change or on
  any write to that user's follows or selections.

Calendar clients poll on their own schedule (hours, not minutes) and you cannot control it, so the
per-user render still needs a conditional-GET path (`ETag` on `snapshot_version` + the user's
selection version) to stay cheap.

### Notifications: sweep, do not pre-enqueue

Do **not** enqueue a delayed job per (match, user) when a match is created. Instead run a periodic
sweeper that queries "notifications due in the next N minutes" and dispatches them.

Why this is the right shape: a rescheduled match requires **no cancellation logic at all** — the
sweeper simply never sees the old time. Pre-enqueued jobs would need a stable key, a cancellation
path, and a correctness test for every reschedule case. The sweeper deletes that whole category of
bug. It is the same argument as FR-1 rule 6, and for the same reason: bind to the match, not to the
time.

Fan-out (one match → many subscribers) is the one place with real write amplification, and is what
the queue is actually for.

---

## 7. What this project can and cannot teach

The owner's goal includes practising system design, and specifically working through the "scale from
zero to a million users" bricks. This section is an honest accounting of which of those bricks this
particular workload earns, because forcing the rest would produce diagrams rather than learning.

**Why the back half of that curriculum does not fit here.** It assumes data and write volume grow
with users. This workload is the opposite shape: the dataset is tiny (order 10⁴ matches a year) and
**identical for every user**, per-user state is a few hundred bytes, and NFR-2 means read traffic
never reaches upstream. There is no bottleneck for replication or sharding to attach to. If the goal
is to walk the whole curriculum including sharding, a purpose-built project with per-user write
growth is the faster vehicle — that is the owner's own read and it is correct.

### The six this workload earns

| Brick | Why it is real here | Measure first |
|---|---|---|
| **Stateless web tier** | Required for horizontal scaling, zero-downtime deploys, and for the iOS app to hit any instance. | That killing an instance mid-request is invisible. |
| **Load balancer** | Follows from the above. Run ≥2 instances early so state leaks surface. | Requests distributed; one instance down changes nothing. |
| **Cache tier** | Read-frequently, modify-hourly — the textbook case. The global snapshot and the per-user render are two different caching problems (§6). | Hit ratio, and origin requests before vs after. |
| **CDN** | The highest-leverage brick here. The snapshot is one object identical for every user. | Bytes served from edge vs origin; p95 by region. |
| **Message queue** | Notification fan-out and retry: one match → many subscribers is the only real write amplification. Modest volume; do not oversell it. | Fan-out depth, retry rate, delivery latency. |
| **Logging / metrics** | How NFR-4 and NFR-5 are verified at all. Per-source health and staleness age are the only way an empty parse becomes visible. | That an induced empty parse shows up on the dashboard. |

Every row has a "measure first" column on purpose. A brick added without a before-measurement cannot
be shown to have helped, and §6 already contains one conclusion that has no measurement behind it.

### The four this project should not pretend to need

- **DB read replica** — one Postgres handles this for years. Worth building *once*, as an explicit
  exercise in observing replication lag and read-after-write anomalies, and labelled as practice. It
  is stage 10, and a negative result is the expected result.
- **Sharding** — matches accumulate at ~10⁴/year. Sharding solves storage and write throughput; this
  has neither problem. If the exercise is wanted, time-based **partitioning** on `starts_at_utc` is a
  real technique with a real, modest payoff, and belongs in the same study stage.
- **Celebrity / hotspot** — would have appeared as a live-traffic spike on one match. Dropping "live"
  removes it. The condition that brings it back: any real-time feature.
- **Multi data center** — the CDN already solves latency for the only large payload. Becomes real
  under a hard availability SLA, which this does not have.

### The four problems this project actually has

These are more valuable here than the four above, and the standard curriculum barely covers them.

1. **Reliability against a source you do not control.** Idempotent upsert, partial failure isolation,
   semantic canaries that survive an off-season, staleness made visible to users. This is already the
   strongest part of the codebase and it is the part with no textbook chapter.
2. **Caching something that is *almost* shared.** The overview is identical for everyone; the
   calendar is not. Getting the layering right (§6) is a deeper caching lesson than adding Redis.
3. **Scheduled delivery over mutable data.** Matches move. Sweep-versus-pre-enqueue is a real
   distributed-systems decision with a clean argument, and it deletes a whole class of bug.
4. **One API feeding three clients.** Web, ICS, and native iOS. This is where API-first stops being a
   slogan: writing the Swift client is what proves the API was not secretly web-shaped.

---

## 8. Stages

One stage at a time. Do not start the next unprompted.

| # | Deliverable | Done when |
|---|---|---|
| **0** ✅ | Source adapter interface + `riot-rest-lol`. No DB, no server. | A CLI prints the next 7 days of a covered league in correct Taipei time. Golden fixture + parser test exist. |
| **0.5** ✅ | Team identity: the `getTeams` narrowed join. | Every non-TBD side in a covered league resolves; second teams resolve to nothing rather than to their parent; an ambiguous code warns and resolves nothing. |
| **0.6** ✅ | Fixture maintenance doctrine, before Stage 1's sync worker starts depending on it. `capture-fixture.ts`'s broken env-var name fixed; split into three commands (`capture`, `capture:check`, `capture:refresh`) sharing `scripts/capture-lib.ts`; a shared, unit-tested sidecar schema (`src/fixtures/sidecar.ts`) validated against all 15 then-committed sidecars; `rest_getTeams_full.json` (the untrimmed 1568-row capture) committed so the join-key collision figures are re-derivable from the repo, not from a session. | Fixtures are frozen test inputs, never auto-refreshed — every capture command writes to a new path or requires an explicit `--write`. `tests/fixture-sidecars.test.ts` and `tests/fixture-transform.test.ts` pass, the latter proving `rest_getTeams.json`'s recorded transform actually reproduces it from the full capture. |
| **0.7** ✅ | `getSchedule` forward pagination: `fetchMatches` crawls `pages.newer` to exhaustion instead of returning one ~5-day window. | The adapter returns the full forward horizon Riot has (verified 2026-08-12: 6 requests, 436 events, terminal `pages.newer === null`), not one page. A crawl that cannot finish returns what it has and says so (`crawl-incomplete` + `diagnostics.crawlComplete`), never throwing away the near-now page. `timeWindow` stays `false` and the pinning test still agrees. A multi-page golden fixture exists whose recapture instruction is "crawl until `newer` is null", not "replay these tokens". Added because a database built on the pre-0.7 fetch (~1.5 days of future) cannot support FR-2's overview; discovered while preparing Stage 1. The `older` (backward) direction is probed but unresolved — a 6-page backward crawl did not terminate — and is needed before historical backfill; see `docs/sources/lolesports-rest.md`. |
| **0.8** ✅ | API boundary survey: every Riot REST endpoint this project touches or has considered touching, probed live and logged, plus a wire-to-domain map. `npm run probe -- <group>` (`scripts/probe-api.ts`), five groups, 26 live requests, logs committed at `docs/probes/riot-rest/*.probe.json`. | `docs/sources/riot-rest-parameters.md` — every parameter/boundary claim cites the probe id that measured it. Retired an unprobed claim (`getTeams` "no other parameters" — `id` narrows cleanly) and strengthened the name-join's locale-stability premise from two fixtures three days apart to a same-instant, exhaustive A/B (1568/1568 teams, zero mismatches — the stage's one stop-and-report trigger, which did not fire). `docs/DATA_FLOW.md` maps every `SourceMatch`/`SourceTeam`/`SourceLeague` field to its wire origin, with diagrams for the lifecycle, the three-endpoint join, and where each `WarningCode` fires. No `src/` behaviour changed. |
| **1a** ✅ | Schema, source registry, identity crosswalk, idempotent sync. | Sync twice → zero duplicates, and a genuinely unchanged row's `updated_at` does not move either. TBD matches persist. NFR-8 (a user's `selection`/`follow` row is never touched by sync) has a DB-backed test. |
| **1b** ✅ | Source health + canary scheduling, and the degradation semantics 1a's "done when" didn't cover: what sync does when the upstream is half-broken rather than fully up or fully down. | A deliberately broken source (a scope that throws, a `fetchLeagues` outage) does not fail the run — the healthy part still commits, the broken part is recorded and skipped. A transient `getTeams` outage does not erase a previously resolved team id or bump every match's revision. A parse-level drop is never read as a cancellation. A canary catches an empty parse **and stays quiet through an off-season**, and its verdict is recorded (`canary_result`), not just logged. `source_health`/`sync_run` are written on every run, including a failed one. |
| **2** | `follow` + `selection` + JSON read/write API. Two endpoint groups: overview and my-calendar. | The FR-1 rules are a pure function with table-driven tests, covering at minimum: exclude one match of a followed team; unfollow keeps hand-picked matches; a reschedule carries the selection; a TBD side resolving pulls the match in. NFR-8 has a test. |
| **3** | Web: overview page (filter / follow / pick) + calendar page. Anonymous, no account. | Full flow works with no account. Applying a filter issues no write (FR-2). Spoiler-free is built in, not retrofitted. Past matches browsable without revealing scores. |
| **4** | Google OAuth + anonymous data migration. | Follow and pick anonymously → sign in → both tables intact, not duplicated. |
| **5** | ICS export. | Subscribed in real Google Calendar; changing a match time **updates** the existing event rather than duplicating it. `DTEND` is the §1 estimate and is documented as such. |
| **6** | Notification sweeper + Web Push. | Notification fires; rescheduling a match produces no notification at the stale time. |
| **7** | Native iOS app + APNs. | Feature parity with web for browsing, following, picking. Any API change needed to make Swift comfortable is a **finding about NFR-1**, and gets recorded. |
| **8** | Observability + CI/CD. | Dashboard shows per-source sync health, staleness age, p95. The snapshot is serialised and its real size recorded (§6). |
| **9** | Cache + CDN + ≥2 instances behind LB. | Hit ratio observable with before/after numbers against stage 8's baseline; killing an instance is invisible to users. |
| **10** | *(study track)* load test, read replica, partitioning. | Before/after measurements written up — **including where the gain was negligible.** A measured "this changed nothing" is the expected result and is worth keeping. |
| **11** | *(deferred)* a second title. | Only reached once the LoL calendar is complete. Follow, calendar, ICS and notification logic work with no changes to core logic; only a new adapter is added. |

### Why this order, where it changed, and what it costs

**iOS moved up, from 9 to 7.** It is the delivery the owner most wants, and it was scheduled behind
the entire scaling track — that is, behind optimising for users who do not exist yet. It cannot be
first, because a native client needs a JSON API and that needs the schema and the sync. But it needs
almost no *backend* work beyond stage 2 if NFR-1 is honoured, so its real cost is Swift, an Apple
Developer account, and APNs.

**Observability moved ahead of caching**, 8 before 9. The two were the other way round, which
contradicted the project's own rule about instrumenting a bottleneck before building for it. Stage 9's
"done when" now depends on a baseline that stage 8 produces.

**ICS moved down, from 3 to 5.** An earlier revision of this plan put it at 3 on the reasoning that
it is the cheapest route to "usable on my phone". That reasoning assumed the calendar was derivable
from follows alone. It is not: the product's core interaction is picking and un-picking individual
matches, which is a write, and ICS is read-only. So the surfaces in FR-2 have to exist first, and ICS
becomes an export of what they produce. The owner also called it wanted-but-not-urgent.

Stages 5 and 6 can be swapped without affecting anything else. There is an argument for ICS first:
once it exists, the user's own calendar app provides reminders, which may reveal that self-hosted push
is worth less than it looks.

**A second source is last, and this costs something.** CS2 via BLAST once sat before the caching
stage, deliberately, on this reasoning: adding a genuinely foreign source will force schema changes,
and building a scaling layer on a schema that has never faced a second source means building on sand.
Validate the abstraction, then scale it.

That reasoning was not refuted; it was overruled by the scope decision in §0, and the price is
recorded here rather than discovered later: **stage 9's cache and CDN will be built on a schema no
second source has ever tested.** If a second source is ever added and the schema has to change, that
is the explanation — an informed trade, not an oversight.

What reduces the risk without removing it: the adapter interface *was* designed against three probed
sources before any of it was written, so the shape has met foreign requirements even though the
persistence layer has not. BLAST remains the exam worth sitting if one is ever sat — no global
schedule, no league tier, inverted TBD and sweep conventions, two vocabularies for one entity, three
distinct error shapes, and the `/brackets` finding in §4. VALORANT would be the weak version: same
backend, same key, one path segment apart.

---

## 9. Open decisions

**League research, and the LTA/LCS question.** The owner will supply the full league list from the US
lolesports site (the Taiwanese one does not show it) for a proper classification pass. Two things to
settle then: whether coverage widens beyond eight, and what the relationship is between the `lcs`
slug and `lta_n` / `lta_s` / `lta_cross`. All four exist in `getLeagues`; `lcs` had four matches in
the 2026-08-09 window and the three LTA slugs had none. Until that is understood, `lcs` is the
covered slug and the LTA slugs are minor.

**`ewc_lol`.** An international event, excluded from phase one as a product decision. The most likely
first readmission. `fixtures/riot-lol/rest_getSchedule_ewc.json` and the test built on it are kept
for exactly that reason.

**Duration estimates.** §1 fixes Bo1/Bo3/Bo5 at 60 min / 3 h / 5 h by judgement, not evidence. If it
matters,
the way to get real numbers is to measure actual broadcast lengths, which requires data this project
deliberately does not collect. A defensible alternative: no `DTEND` at all, and all-day or
point-in-time events. Not decided.

**Hosting.** PaaS target undecided (Fly.io / Render / Railway). Deferred until stage 3 needs it.

**Coverage review cadence.** `config/leagues.json` is hand-maintained and rots by omission. A new
league resolves to `unclassified` and warns, which is the mechanism; how often the warning is acted
on is unresolved.

**Apple Developer account.** US$99/year, required before stage 7 can ship anything installable.

**A collision invariant test was discussed and not written.** The proposal: for every colliding key in
the team index, assert that it either has a matching override or resolves to nothing with a warning —
never to an arbitrary pick. It asserts the *safety property* rather than a count, so it holds on a
fixture of any size and only goes red when someone adds an incomplete override. Its value dropped once
the join moved to `name` (zero name collisions in the narrowed table, so there is currently nothing for
it to iterate over), which is why it was left undone rather than dismissed. Reconsider if a name
collision ever appears, or before widening coverage.

**The full `getTeams` capture is now committed and test-backed.**
`fixtures/riot-lol/rest_getTeams_full.json` (1568 rows, `players` stripped — the only personal-data
field the parser was already required to discard) replaced the ungitignored, machine-local
`rest_getTeams_en.json` as the source of truth for these figures. `tests/team-index-collisions.test.ts`
asserts them directly against the committed file: 46 code collisions / 15 name collisions over all
1176 active rows, 0 / 1 (EG) narrowed to the eight covered leagues' regional teams (168 rows).
`rest_getTeams_en.json` itself remains gitignored and untouched — the fix was committing a
`players`-stripped sibling, not exposing the original.

This is not theoretical. A figure in that note said 27 colliding codes among all active rows for two
days; the real number is 46, and 27 turned out to be the count of collisions involving an academy squad.
Nothing caught it because nothing could — the response was not in the repo and no test asserted it. It
surfaced incidentally, while measuring `name` against `code` for the join-key decision. **That failure
mode is now closed**: the figures live in a test, not only in a comment.

**`hl=en-US`, and a disclosure that turned out to be more permanent than expected.** Every request
pins it, for two verified reasons: display fields come back translated, and `getTeams.homeLeague`
joins by localized name, so identity must resolve from one fixed locale. **But the primary schedule
fixture was captured under `hl=zh-TW`** — recorded in `fixtures/riot-lol/rest_getSchedule.meta.json`
as a known discrepancy. The visible symptom is that the CLI prints `第11週` where live would print
`Week 11`.

A locale-correct reference capture exists (`fixtures/riot-lol/rest_getSchedule_2026-08-11.json`) and
confirms the fix works. **It does not replace the original**, and a plain re-capture cannot close
this: `getSchedule` with no parameters returns whatever is near "now" at request time, not a fixed
slice of history, so two days after the original capture several edge cases specific tests depend on
— 9 "lossy-state" corrections among them — no longer exist in any fresh capture, by construction. No
assertion currently depends on a mistranslated field, so nothing is silently wrong; but closing this
for real needs a coordinated re-capture of every `riot-lol/` fixture on one day, plus rewriting the
tests that assert exact counts and hardcoded ids from the 2026-08-09 capture into structural
assertions. `fixtures/REQUIREMENTS.md` is the checklist for that day.
