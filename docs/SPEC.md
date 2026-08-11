# Esports Calendar — Product & Architecture Spec

> Source of truth. Claude Code reads this before planning any stage.
> If reality diverges from this document, update the document. Do not let code and spec drift.

---

## 0. One-line definition

A **League of Legends esports match calendar**. Users follow leagues and teams; matches they care
about appear in a web calendar, a subscribable ICS feed, and (later) a native iOS app — each match
carrying a stream link and an optional pre-match notification.

The target is simple to state: **every match the lolesports.com site shows, in one calendar you
can subscribe to.**

### Scope decision, 2026-08-09: LoL only

This document previously read "League of Legends is the first title implemented. It is not the
product." That is no longer the plan. VALORANT and CS2 adapters are off the roadmap.

**The cross-title design is kept and paid for; only the implementation is deferred.** Three real
sources were probed before the interface was written, and what they forced stays in:
`SourceCapabilities`, the `game` field on the domain types, the optional `league`, the two-phase
`listScopes` → `fetchMatches` shape, and the four notes in `docs/sources/`. The marginal cost of
keeping them is near zero, unpicking them would cost a working session, and they are the reason
the interface is not simply a transcription of Riot's response shape.

`docs/sources/valorant.md` and `docs/sources/cs2-blast.md` are retained as findings, not as
pending work. For the record: VALORANT shares Riot's backend — same key, same envelope, one path
segment apart (`/persisted/val/` vs `/persisted/gw/`) — so if cheap multi-title validation is ever
wanted again, it is an hour of work rather than a session.

---

## 1. Scope

### In scope

| Area | Decision |
|---|---|
| Titles | **LoL only.** The abstraction that would carry a second title is built and kept; adding one is deferred indefinitely (see §0). |
| Event tier | **Officially broadcast major events only.** No tier 2/3, no amateur, no qualifiers-without-broadcast. The list of which leagues qualify is hand-maintained in `config/leagues.json`; it cannot be derived from the API — see §4. |
| Subscription | League and Team. |
| Delivery | Web app → ICS feed → native iOS app. API-first throughout. |
| Streams | Official streams per match + user channel override. |
| Notifications | Default 30 min before + at scheduled start. User-configurable lead time. |
| Accounts | Anonymous browsing allowed; account required to persist a personal calendar. |
| Auth | Google OAuth. |
| Licensing | **Open source.** Data sources attributed. |

### Explicitly out of scope

Player data, coach data, rosters, transfers, contracts. Live scoring, live match state, in-progress
badges. Match statistics, picks/bans, VODs. Standings and brackets. Betting, predictions, social
features.

The absence of player data and live state is a deliberate simplification, not an oversight.
Do not reintroduce either without an explicit decision recorded here.

### The consequence of dropping "live"

Notifications fire on the **scheduled** time, not on the actual broadcast start. A match that
starts 20 minutes late produces an early notification. This is accepted.

In exchange: sync can run hourly rather than continuously, cache TTLs can be long, and there is
no traffic spike concentrated on a single match. This removes the largest source of complexity
in the system.

---

## 2. Functional requirements

### FR-1 Subscription
- Any number of leagues and teams.
- Team subscription is tournament-agnostic: following T1 surfaces T1 matches in domestic league
  and international events alike.
- Visible set is the **union**, **de-duplicated**. A match matching both a followed league and a
  followed team appears once.
- Anonymous users subscribe via browser-local storage. Signing in migrates those subscriptions
  into the account without duplicating or overwriting existing ones.

### FR-2 Calendar views
Agenda (chronological list, default), week, month. "Today" reachable in one interaction.

### FR-3 Spoiler-free mode
Default ON. Completed matches show teams and time but not score or winner until explicitly
revealed. Applies to ICS `SUMMARY` as well — never put a score in it.

### FR-4 Stream resolution
First match wins:
1. User preference scoped to the **team**
2. User preference scoped to the **league**
3. User's global preferred provider + locale
4. Source-provided official stream for the user's locale
5. Source-provided default stream

A preference is `(provider, channel)` — e.g. `(twitch, "lck")`. Links out; no embedded player.

### FR-5 ICS feed
Per-user URL with an unguessable token (not the user id). Stable `UID` per match. `SEQUENCE`
increments when a user-visible field changes. `VALARM` carries the reminder. Same subscription
set and spoiler rules as the web UI.

### FR-6 Notifications
- Defaults: 30 minutes before, and at scheduled start.
- Lead time user-configurable; either notification independently disableable.
- Channels are pluggable. v1: ICS `VALARM`, Web Push. Later: APNs for native iOS.
- A rescheduled match must not fire a notification at the stale time.

---

## 3. Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-1 | **API-first.** Every capability is available over JSON API. No web-only logic — the iOS app must be able to do everything the web can. |
| NFR-2 | **Source isolation.** User requests never trigger an upstream fetch. Only the sync worker calls upstream. |
| NFR-3 | **Source independence.** No source's identifiers, response shapes, or URLs leak above the adapter boundary. |
| NFR-4 | **Partial failure isolation.** One broken source must not fail the sync run or empty the calendar for other titles. |
| NFR-5 | **Visible staleness.** Per-source freshness is queryable and surfaced in the UI when stale. Never silently show an empty calendar. |
| NFR-6 | Stateless web tier. No session or user state in process memory. |
| NFR-7 | UTC in storage; timezone conversion only at render. |

---

## 4. Data sources

### Strategy

Sources are **self-built adapters against official event sites**, one per source, normalized into
a common domain model. There is no single upstream vendor.

Rationale: scope is limited to officially broadcast major events, so the number of sources is
bounded and small. Each adapter extracts only five fields per match (time, teams, format, state,
streams), which is shallow enough to be robust.

### The unit of a source is an ORGANIZER, not a title

LoL and VALORANT each have one official Riot-run site. **CS2 does not** — its major events are run
by separate organizers (ESL, BLAST, PGL), each with its own site. Dota 2 is similar post-DPC.

Therefore: one title may have many sources; one source may span titles. The schema must model
`source` as a first-class entity, not as a column on `game`.

### Probed sources — see docs/sources/ for full notes

| Source | Game | Global schedule? | League tier? | Explicit state? | Stream URLs? |
|---|---|---|---|---|---|
| Riot GraphQL (`lolesports.com/api/gql`) | LoL | yes | yes | yes (`match.state`) | no |
| Riot REST (`esports-api…/persisted/gw`) | LoL | yes | yes | lossy — see note | no |
| Riot REST (`…/persisted/val`) | VALORANT | yes | yes | yes | no |
| BLAST (`api.blast.tv/v2`) | CS2 | **no** | **no** | **no** | **yes** |

Riot's LoL and VALORANT share one backend; the title is chosen by the path segment
`/persisted/{gw|val}/`. The domain is an alias and the `sport` query parameter is ignored.

Riot REST's single `state` field reports unplayed TBD playoff matches as `completed`; the
GraphQL `match.state` is correct. Use GraphQL as primary, REST as failover and for historical
backfill via its working cursors.

### Consequences for the interface

**Fetching is two-phase.** BLAST has no global schedule endpoint — matches are only reachable at
`/tournaments/{slug}/matches`, so a scope must be known first. The interface enumerates scopes,
then fetches per scope; Riot returns a single global scope. Shaping to the weaker capability is
deliberate.

**Capabilities are declared, not assumed.** Sources differ in what they can do, not only in field
names. `SourceCapabilities` makes the sync layer branch honestly instead of discovering nulls at
runtime.

**`league` is optional.** BLAST has `tournament → stage → match` only; its `circuit` is a year tag.

**`seriesLength` and `gamesPlayed` are separate.** A Bo3 ending 2-0 gives Riot three games with
the third `"unneeded"`, and BLAST an array of two.

**TBD is first-class.** Riot uses a sentinel (`code: "TBD"`, id suffix `:0`); BLAST uses `null`.

**Stream URLs are a capability.** BLAST supplies per-match URLs; Riot supplies none, so LoL and
VALORANT fall back to a manually maintained `League.defaultStreamUrl`.

**There is no tier signal anywhere.** Riot's `priority` is `1` for all 45 LoL and 55 VALORANT
leagues, and `displayPriority` is per-request UI state — CACG returned `hidden` from one endpoint
and `selected` from another the same day, and LCK and LPL are `not_selected`. Sync every league
into the DB with `tier` defaulting to `unclassified` and surface new ones for manual review.

The tier list is stronger than "no signal we trust": **the site itself filters above the API and
does not expose the filter.** KeSPA Cup is returned by `getLeagues` with `not_selected` and does
not appear in the site's league picker at all — so `not_selected` never meant "shown but unticked".
Verified by direct observation of the site, 2026-08-09; the earlier reading was inferred from the
field name and is corrected in `docs/sources/lolesports-rest.md`.

So the list is transcribed by hand from the site into `config/leagues.json`, which holds a tier per
league slug and the manual team overrides that go with it. Being unable to derive it is *why* it is
a config file: it changes on a product decision, not a deploy. An explicit `minor` and an absent
slug are different states — absence means a league appeared upstream after the file was reviewed,
and it warns. Three leagues appeared during 2026 alone.

Tier gates two things, not one: which teams enter the team master table, **and** which matches have
their teams identified at all. Both are required — see §5 on identity.

### Agents: build-time only

An agent (Hermes, Claude Code) may be used to explore a new site, identify its endpoints, infer
response shapes, and **write the adapter**. This is the intended way to keep per-source cost low.

An agent must **never** be part of the runtime sync path. Agent output is code, not data.
Runtime parsing is deterministic, unit-tested, and runs in CI.

### The failure mode that matters

Scrapers rarely fail loudly. They return HTTP 200, valid JSON, and **zero rows**. Every health
check stays green while the calendar quietly empties.

**This is confirmed in the wild, not hypothetical.** `GET /v2/games/cs/tournaments/NOT-A-REAL-SLUG/matches`
returns HTTP 200 and `[]` — indistinguishable from a real tournament with nothing scheduled yet.
Typo one slug and that tournament silently disappears from the calendar.

Two mandatory mitigations, both from Stage 1:

1. **Golden fixtures.** Every source's real response is snapshotted to disk. Parsers are tested
   against those fixtures in CI. An upstream shape change turns CI red immediately.
2. **Semantic canaries.** Scheduled assertions of the form "LCK has at least one match in the next
   14 days." An HTTP-level check cannot catch an empty parse; this can.

### Conduct

Polite polling with backoff. Identifying `User-Agent` with contact info. Cache aggressively; never
proxy user traffic upstream. Attribute sources. Since the repo is public, the adapters are visible
— keep the request volume defensible.

---

## 5. Domain model

```
game              (id, slug, name)
source            (id, slug, name, organizer, base_url, enabled)
source_health     (source_id, last_success_at, last_failure_at, consecutive_failures,
                   last_item_count, status)

league            (id, game_id, slug, name, region, image_url, priority)
tournament        (id, league_id, name, starts_on, ends_on)
team              (id, game_id, slug, name, code, image_url)

match             (id, tournament_id, league_id, starts_at_utc, best_of, games_played,
                   block_name, state, revision, updated_at)
match_team        (match_id, team_id NULL, side, score)     -- NULL team_id = TBD
stream            (match_id, provider, channel, locale, is_official)

external_ref      (entity_type, entity_id, source_id, external_id, is_canonical)
                  -- crosswalk; Riot team ids are just one alias among many

user              (id, email, tz, spoiler_free, created_at)
subscription      (user_id, target_type ENUM(league,team), target_id)
stream_pref       (user_id, scope ENUM(global,league,team), scope_id NULL, provider, channel, locale)
notification_rule (user_id, lead_minutes, enabled)
device            (user_id, platform ENUM(web,ios), token, created_at, last_seen_at)
ics_token         (user_id, token, created_at, revoked_at)
sync_run          (id, source_id, started_at, finished_at, status, items_upserted, error)
```

Points worth defending in review:

- **`external_ref` is the identity layer.** Internal ids are canonical; every source's id is an
  alias. Seeded initially from Riot team ids, but the schema never assumes Riot exists. Manual
  override is expected — renames, merges, and new orgs are normal.

  Riot team ids come from `getTeams`, one unparameterised call returning the whole master table.
  The join from a match to that table is by team **code**, and it is only safe because it is
  narrowed twice: to teams whose home league is major, and to matches played in a major league.
  Unnarrowed, 27 codes are claimed by more than one team; narrowed, exactly one is (`EG`, an LCS
  org and an LEC org, both first teams), and that one is settled by a `manualOverride` entry in
  `config/leagues.json`. Dropping the second narrowing silently attaches first-team ids to academy
  squads — measured at 11 sides in a single captured day. An ambiguous code resolves to **nothing**
  and warns; it is never guessed.
- **`source_health` is not bookkeeping**, it is how NFR-5 is satisfied.
- **`device` exists from the start** even though APNs comes later, so the notification core is
  channel-agnostic from day one rather than retrofitted.
- **`revision`** drives ICS `SEQUENCE`. Bump only on user-visible change (time, teams, state), or
  every calendar client re-notifies on every sync.
- **`best_of` and `games_played` are separate columns**, for the reason given in §4. `best_of` is
  the declared series length; `games_played` is how many were actually played. They coincide on
  Riot and diverge on BLAST.

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
              │  ┌────────┐ ┌────────┐ ┌────────┐        │
              │  │ riot   │ │ riot   │ │ esl    │  ...   │
              │  │ lol    │ │ valo   │ │ cs2    │        │
              │  └────────┘ └────────┘ └────────┘        │
              └────────────────────┬─────────────────────┘
                                   │ schedule-change events
                            ┌──────▼──────┐
                            │    Queue    │
                            └──────┬──────┘
                    ┌──────────────┴──────────────┐
                    │  Notification sweeper       │──► Web Push / APNs
                    └─────────────────────────────┘
```

### Key design decision: reads are a shared payload

The full schedule of officially broadcast major events, across all titles, for the next 30 days is
small — hundreds of matches, well under a megabyte serialized. It is **identical for every user**.
Only the subscription list is per-user, and it is tiny.

So: compute **one global snapshot**, version it, cache it, serve it from CDN. Apply the
subscription filter at the edge or in the client. The read path barely touches the database, and
ten users or ten million hit the same cached object.

This is why the data tier never becomes the bottleneck, and why sharding does not address any
problem this system has.

### ICS: cache by subscription set, not by user

Calendar clients poll on their own schedule (hours, not minutes) and you cannot control it.

```
cache_key = hash(sorted(subscription_set) + spoiler_flag + tz + snapshot_version)
```

Users with identical subscriptions share one cached feed. Subscription sets cluster heavily in
practice, so the number of distinct cached feeds is far below the user count.

### Notifications: sweep, do not pre-enqueue

Do **not** enqueue a delayed job per (match, user) when a match is created. Instead run a periodic
sweeper that queries "notifications due in the next N minutes" and dispatches them.

Why this is the right shape: a rescheduled match requires **no cancellation logic at all** — the
sweeper simply never sees the old time. Pre-enqueued jobs would need a stable key, a cancellation
path, and a correctness test for every reschedule case. The sweeper deletes that whole category
of bug.

Fan-out (one match → many subscribers) is the one place with real write amplification, and is what
the queue is actually for.

---

## 7. Chapter 1 brick mapping — honest verdicts

| Brick | Verdict | Why |
|---|---|---|
| **Stateless web tier** | **REAL** | Required for horizontal scaling, zero-downtime deploys, and for the iOS app to hit any instance. |
| **Load balancer** | **REAL** | Follows from the above. Run ≥2 instances early so state leaks surface. |
| **Cache tier** | **REAL** | Read-frequently, modify-infrequently — the textbook case. Snapshot, ICS feeds. |
| **CDN** | **REAL — highest leverage in the project** | Logos and assets, obviously. The interesting use is the global schedule snapshot, which is identical for every user. |
| **Message queue** | **REAL, modest** | Notification fan-out and retry. Justified, but the volume is small. Do not oversell it. |
| **Logging / metrics** | **REAL** | Per-source sync health and staleness age are how NFR-4 and NFR-5 are verified at all. |
| **DB read replica** | **PRACTICE** | One Postgres handles this for years. Build it to observe replication lag and read-after-write anomalies. Label it practice in your notes. |
| **Celebrity / hotspot** | **MOSTLY GONE** | It would have shown up as a live-traffic spike on one match. Dropping live removes it. Note what condition would bring it back: any real-time feature. |
| **Multi data center** | **THEATRE at this scale** | CDN already solves latency for the only large payload. Becomes real under a hard availability SLA. |
| **Sharding** | **THEATRE** | Matches accumulate at ~10⁴/year. Sharding solves storage and write throughput; you have neither problem. If you want the exercise, do time-based **partitioning** on `starts_at_utc` — a real technique with a real, modest payoff. |

**The transferable lesson**: each brick answers a specific bottleneck. Identify the bottleneck
first. Here it is fan-out of a small, universally shared payload — solved completely by CDN and
cache, and not at all by sharding.

---

## 8. Stages

| # | Deliverable | Done when |
|---|---|---|
| **0** | Source adapter interface + first LoL adapter. No DB, no server. | A CLI prints the next 7 days of LCK matches in correct Taipei time. Golden fixture + parser test exist. |
| **1** | Schema, source registry, identity crosswalk, idempotent sync, source health. | Sync twice → zero duplicates. TBD matches persist. A deliberately broken source does not fail the run. Semantic canary catches an empty parse. |
| **2** | Subscription model + JSON read API. | Union of league+team subscriptions returns correctly de-duplicated results. Filter logic is a pure function with table-driven tests. |
| **3** | Web calendar, anonymous, agenda view first. | Usable in a browser with no account. Spoiler-free built in, not retrofitted. |
| **4** | Google OAuth + subscription migration. | Subscribe anonymously → sign in → subscriptions intact, not duplicated. |
| **5** | ICS feed. | Subscribed in real Google Calendar; changing a match time **updates** the existing event rather than duplicating it. |
| **6** | Notification core (sweeper) + Web Push. | Notification fires; rescheduling a match produces no notification at the stale time. |
| **7** | Cache + CDN + ≥2 instances behind LB. | Cache hit ratio observable; killing an instance is invisible to users. |
| **8** | Observability + CI/CD. | Dashboard shows per-source sync health, staleness age, cache hit ratio, p95. |
| **9** | Native iOS app + APNs. | Feature parity with web for browsing and subscribing. |
| **10** | *(study track)* read replica, partitioning, load test. | Before/after measurements written up — including where the gain was negligible. |
| **11** | *(shelved)* CS2 via BLAST. | Only reached if a second title is ever wanted. Subscription, calendar, ICS, and notification logic work with no changes to core logic; only a new adapter was added. |

**The second source moved to the end — and this costs something.** CS2 via BLAST used to sit at
Stage 7, deliberately *before* cache and CDN, with this reasoning: adding a genuinely foreign
source will force schema changes, and building a scaling layer on a schema that has never faced a
second source means building on sand. Validate the abstraction, then scale it.

That reasoning was not refuted. It was overruled by the scope decision in §0, and the price is
recorded here rather than discovered later: **Stage 7's cache and CDN will be built on a schema no
second source has ever tested.** If a second source is ever added and the schema has to change,
that is the explanation — an informed trade, not an oversight.

What reduces the risk, though it does not remove it: the adapter interface *was* designed against
three probed sources before any of it was written, so the shape has met foreign requirements even
though the persistence layer has not. BLAST remains the exam worth sitting if one is ever sat — no
global schedule, no league tier, inverted TBD and sweep conventions, two vocabularies for one
entity, three distinct error shapes. VALORANT would be the weak version: same backend, same key,
one path segment apart.

Stage 10 is explicitly a study track. Keep negative results — a measured "this changed nothing" is
worth more than an unmeasured architecture diagram.

---

## 9. Open decisions

- PaaS target for Stage 7 (Fly.io / Railway / other).
- **`hl=en-US` is pinned on every request — SETTLED, recorded here because it is load-bearing.**
  Two independent reasons, both verified:
  1. Display fields are translated. `blockName` is `"Week 11"` under `en-US` and `"第11週"` under
     `zh-TW`; `league.region` is `KOREA` / `韓國`. Identity resolved from a varying locale makes one
     tournament into two entities depending on who asked.
  2. **Identity itself now depends on it.** `getTeams.homeLeague` is `{name, region}` — no slug and
     no id — so the only join from a team to a league is by *localized display name*, matched
     against `getLeagues.name`. Mixing locales across those two requests does not error; it
     produces an empty team table and a calendar with no team ids at all.

  Open part: whether a *display* locale is offered to users later. If it is, it must be a second
  request or a render-time concern, never the identity one. See `IDENTITY_LOCALE` in
  `src/sources/riot/rest/client.ts`.
- **Review cadence for `config/leagues.json`.** The major list cannot be derived — the site filters
  above the API and does not expose the filter — so it is transcribed by hand. An unknown slug
  warns at fetch time, which catches new leagues; nothing catches a league that should be promoted
  or demoted. Unresolved whether that needs more than "notice the warning".
- *(shelved with Stage 11)* **How BLAST tournament slugs are discovered.** No tournaments endpoint
  was found; the listing page is server-rendered. Probe `/v2/games/cs/tournaments`, else parse the
  SSR page, else maintain the slug list by hand. A manual list is an acceptable v1 answer.
- *(shelved with Stage 11)* Whether CS users should be able to follow an **organizer** (all BLAST
  events) rather than a tournament, given that CS has no durable league to follow.
- Apple Developer account for APNs (annual fee). PWA + Web Push is the interim path.
