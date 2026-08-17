# CLAUDE.md

League of Legends esports match calendar. Two surfaces: an **overview** of every covered match,
filterable by league and team; and a **personal calendar** of the matches the user chose. Matches
arrive on the calendar two ways at once — by **following** a league or team, and by **picking**
individual matches — and a followed league's matches can still be dropped one at a time. Later:
reminders, and stream links with a user-defined provider order.

**Coverage is eight leagues**, decided by the owner 2026-08-11: `worlds`, `msi`, `first_stand`,
`lck`, `lpl`, `lec`, `lcs`, `lcp`. Everything else Riot returns is out of coverage. This is a product
decision recorded in `config/leagues.json`, not an API limitation, and it is expected to widen after a
proper study of the full league list.

**LoL only, decided 2026-08-09.** Other titles are considered once the LoL calendar is complete. The
cross-title *design* stays — `SourceCapabilities`, the `game` field, optional `league`, the two-phase
scope shape, and all four notes in `docs/sources/`. What that costs is **not** zero and is not
pretended to be: `GameSlug` carries two values nothing produces, and seven fixtures have no reader.
Each is marked in place as a deferred capability rather than as pending work — see the comment on
`GameSlug` in `src/core/types.ts`, which is the inventory. See SPEC §0.

**Read `docs/SPEC.md` before planning anything.** It is the source of truth. If your plan contradicts
it, say so explicitly rather than silently deviating. §§0–2 and §8 were rewritten from the owner's own
requirements on 2026-08-11; everything older had been extrapolated by a model and never reviewed.

## Working agreement

- Plan mode for anything beyond a single-file change. Show me the plan before editing.
- **If execution diverges from the approved plan, stop and say so.** A reduction in scope or
  destructiveness still counts as divergence and still gets reported.
- Evidence before claims. Never say "tests pass" or "this works" without showing the output.
- One stage at a time (SPEC §8). Do not start the next unprompted.
- Tell me when you find a wrong assumption in this file or SPEC.md. Do not edit SPEC.md without
  asking.
- Ask before adding a dependency.
- Work on `stage-<n>-<name>`. I merge to `main`, you do not.

## Non-negotiable constraints

- **API-first.** Every capability is available over JSON API. No web-only logic — a native iOS client
  must be able to do everything the web can. Stage 7 is the exam for this, and anything the Swift
  client needs added is a finding about the API, not a task.
- **Source isolation.** User requests never trigger an upstream fetch. Only the sync worker calls
  upstream.
- **Adapter boundary.** No source's URLs, credentials, identifiers, or response shapes leak above the
  adapter interface.
- **A capability flag describes the code, not the endpoint.** `riot-rest-lol` declares
  `timeWindow: false` even though Stage 0.7 gave `fetchMatches` a real cursor: the query parameter
  is `pageToken`, base64, decoding to `newer::<snowflake>` — verified 2026-08-12 by crawling forward
  to exhaustion (6 requests, 436 events, terminal `pages.newer === null`; see
  `fixtures/riot-lol/rest_getSchedule_crawl_2026-08-12/` and `docs/sources/lolesports-rest.md`). The
  flag stays `false` because `fetchMatches` uses that cursor to crawl the *whole* forward horizon,
  not to narrow to one — the opposite of what `timeWindow: true` would mean, and the `window`
  argument is still ignored outright. And `explicitState: false` although a `state` field exists,
  because the adapter overrides it. A flag that overstates the implementation is worse than an
  absent one, since the sync layer branches on it. Pin the flag to the behaviour in a test.
- **Filter is not follow.** Filtering the overview is view state and must issue no write. Following is
  stored data that changes the calendar. Blurring the two makes the product's central behaviour
  unpredictable, and it is the easiest thing in the UI to blur.
- **A user's explicit selection is never overwritten by sync.** Ingestion may add, update or cancel
  matches; it may not touch a `selection` row. Picking and un-picking are statements of intent, and an
  hourly job must not have opinions about them.
- **Agents are build-time only.** An agent may explore a site and write an adapter. An agent is never
  part of the runtime sync path. Agent output is code, not data.
- **Golden fixtures.** Every source adapter has a snapshotted real response and a parser test against
  it. No adapter is complete without one.
- **Every fixture records the request that produced it** in a `<fixture>.meta.json` sidecar: full URL,
  every query and path parameter, non-secret headers, and the capture date. A fixture whose parameters
  are unknown cannot be re-captured or compared against live, and a mismatch between it and what the
  client actually sends is invisible — `rest_getSchedule.json` was captured under `hl=zh-TW` while the
  client pins `hl=en-US`, and nothing surfaced that until a sidecar was written. `npm run capture`
  writes both halves; use it rather than saving a response by hand. State plainly which fields were
  verified and which were inferred. **`fixtures/README.md` is where the full doctrine lives** — why
  fixtures are frozen test inputs rather than live data, the recapture ritual, and which files are
  retained evidence rather than pending work. Read it before touching anything under `fixtures/`.
- **Fixtures are verbatim, with two exceptions, and both are recorded in the sidecar.**
  1. A field SPEC excludes as personal data may be removed. The sidecar then says
     `verbatim-except-<fields>`. `getTeams` carries a `players` roster and is the case this exists for.
  2. The top-level collection may be trimmed for size. The sidecar records the before and after
     counts. `rest_getTeams.json` is 71 of 1568 rows; `rest_getSchedule_ewc.json` is 6 of 28.

  Nothing else. Trimming a field the parser is required to discard costs no test fidelity, whereas
  real players' names in a public repo that says it does not collect player data is a substantive
  problem. Neither exception is licence to trim inconvenient fields. **A trimmed fixture cannot
  support a figure measured on the full response** — say so where the figure appears, and assert only
  what the committed file can actually hold.
- **Coverage gates two different sets, and they are not the same list.** Which matches have their
  teams resolved: all eight covered leagues, international events included, because a Worlds match
  must resolve T1. Which leagues define who the teams are: regional leagues only. `getTeams` homes
  seven active rows at Worlds and MSI and none is a team that plays — five are 2011-era orgs, two are
  region placeholders literally named "LCS" and "VCS" carrying those codes. Hence `LeagueKind`, and
  hence `kind` being required on every covered league. This was invisible while coverage was fourteen
  regional leagues; narrowing to eight exposed it.
- **Team identity is a narrowed join, and the key is `name` with `code` as a fallback.** Riot names
  teams in `getSchedule` and identifies them in `getTeams`. Measured against the full 1568-row capture
  under the eight-league coverage: over all 1176 active rows, names collide 15 times against 46 for
  codes; narrowed to covered regional leagues (168 rows), names collide **zero** times against one for
  codes.

  The decisive difference is *which* collisions. **A code identifies the organisation, not the squad**,
  so all seven LCK orgs with an academy team share a code between parent and academy — and none share
  a name (`kt Rolster`/`kt Challengers`, `Dplus KIA`/`DK Challengers`, `BNK FEARX`/`BNK FEARX Youth`,
  …). Under a code join an academy side resolves to its parent: a wrong identity that looks exactly
  like a right one. Under a name join it is simply absent from the narrowed table, so the lookup misses
  and says so. **Safety by construction rather than by a guard.**

  Names are locale-stable, which is what makes this viable: the schedule fixture is `hl=zh-TW` and the
  team table `hl=en-US`, and all 60 names match byte for byte, while `blockName` in the same document
  is translated. There is a test for this.

  `code` remains as a fallback for a rename that has reached one endpoint and not the other; a fallback
  hit raises `team-name-mismatch` — right answer, early warning. The tier gate stays, but it is now a
  **scope** decision rather than the safety mechanism it used to be. An ambiguous match resolves to
  nothing and warns; a manual override in `config/leagues.json` can settle a code collision.

  Six active rows carry trailing whitespace in `name`, so the key is trimmed and lower-cased. Measured:
  that introduces zero additional collisions.
- **Out of coverage never means discarded.** An uncovered league's matches are still parsed and still
  carry team names; only resolved identity is withheld, and no warning fires because an explicit
  `minor` is a recorded decision rather than news. Narrowing coverage must not lose matches.
- **Semantic canaries, not liveness checks — and they must survive an off-season.** Scrapers fail by
  returning HTTP 200 with zero rows, so health checks assert content. But "league X has a match in the
  next 14 days" is the wrong shape for a seasonal sport: the three international majors have zero
  matches for most of the year, measured against the capture, and regional leagues have splits breaks.
  A canary that cries wolf on schedule gets muted, and then the next real outage is silent. Assert
  instead that every covered *regional* league appears in the fetched window at all, and separately
  that *something* is scheduled ahead. Confirmed in the wild: BLAST returns 200 + `[]` for an unknown
  tournament slug, indistinguishable from a real tournament with nothing scheduled.
- **Enumerate, never assume closed sets.** `type: "show"` events carry no `match` object. A fixture
  proves existence, never absence — warn on unknown enum values rather than throwing or dropping.
- **Partial failure isolation.** One broken source, or one broken league within a source, must not
  fail the sync run or empty the calendar for the rest.
- **Idempotent ingestion.** Every sync write is an upsert. Running sync twice is a no-op.
- **Internal canonical ids.** Source ids are aliases in `external_ref`, never primary keys. Ids are
  opaque strings: Riot uses numeric snowflakes, BLAST uses UUIDs. Key `external_ref` by
  `(source, game, external_id)` — the game dimension buys out an unverified assumption for one column.
- **Declared capabilities, not assumed uniformity.** Sources differ in capability, not just field
  names. BLAST has no global schedule endpoint, no league tier, and no state field.
- **Parse timestamps per field.** Zone markers are inconsistent even within one object. A timestamp
  with no zone marker is refused, never guessed at.
- **UTC in storage.** Timezone conversion only at the render boundary.
- **No end time is stored.** Riot supplies none. Duration is estimated from `best_of` at render and
  labelled as an estimate; persisting a fabricated `ends_at_utc` would launder a guess into the data
  model where the next reader cannot tell it from a measurement. See SPEC §1.
- **Stateless web tier.** No session or user state in process memory.
- **A credential is never a primary key, and the two tokens are not interchangeable.** An anonymous
  user is an `app_user` row with `email IS NULL`, addressed by an opaque bearer token in
  `Authorization: Bearer` — never by `app_user.id`, which is free to appear in logs, errors and
  links precisely because it grants nothing. Two token tables exist and must stay separate:
  `user_token` grants full write and travels in a header; `ics_token` (FR-5) grants read only and
  travels inside a URL that Google Calendar stores in plaintext. Sharing one value between them
  would make a read-only leak into a write compromise. Not a cookie, either — a cookie is carried
  by the browser, and NFR-1 forbids logic a native client cannot reproduce. Decided 2026-08-17;
  SPEC §2 FR-1 records the accepted risk.
- **Spoiler-free by default.** No score or winner in any default view, and never in ICS `SUMMARY`.
  Past matches *are* shown — they are in scope — so this is load-bearing rather than theoretical:
  scores are stored and simply not rendered unless asked for.

## Out of scope — do not build

Player, coach, roster, transfer, or contract data. Live match state, live scores, in-progress badges.
Match statistics, picks/bans, VODs, standings, brackets. Leagues outside the eight covered.

These are deliberate exclusions. The player-data one is enforced in code, not just documented:
`players` is undeclared in the `getTeams` zod schema so rosters are stripped at the boundary, and two
tests assert both that the fixture contains no player names and that no parsed record does. If a task
seems to need one of these, ask rather than assume.

## How source notes are written

**Every speculative claim states where its confidence comes from.** "Inferred from a 5-row
cross-check" and "verified exhaustively against all 80 events, zero exceptions" are different claims
and must not be written in the same voice. Label the basis: sampled, cross-checked,
exhaustive-over-one-capture, or assumed. State the sample size.

This is not documentation hygiene, it is a bug class. `lolesports-rest.md` described inferring match
state from `result == null` as a "partial workaround… inference, not data". That wording was written
from a five-id cross-check. Checking all 80 events showed the signal is exact — 7 of 7 unplayed
matches have a null result, 0 of 73 played ones do. The adapter had already been written to merely
*warn* about the bad state field instead of correcting it, because the note's hedging made correction
sound unfounded. **The prose talked the implementation out of the right answer.**

Corollary: when a claim is upgraded from sampled to verified, encode the evidence as a test, not only
as a paragraph. An exhaustive check is exhaustive over one capture, and the next capture is not bound
by it.

Second corollary, learned the hard way: **a measurement is only a claim if a reader can reproduce it.**
The `getTeams` figures were measured against a 1.5 MB response that is not in version control, and
were written in the voice of an exhaustive verification while the committed 71-row fixture could not
support any of them. The fix is both halves — say so where the number appears, and make the capture
repeatable (`npm run capture`). A number nobody can re-derive is an assertion about a past session.

**Do not justify a product decision with evidence.** An earlier version of `config/leagues.json`
defended its contents by an observation of the lolesports.com league picker — a single unrepeatable
human observation, with no artifact, load-bearing for the whole tier gate, and *unnecessary*: coverage
is the owner's choice and needs no proof about Riot's website. What the API measurements establish is
only the narrower claim that a tier cannot be derived, which is why coverage lives in a config file.

## Read before designing anything

`docs/sources/lolesports-rest.md` first — it is the only source implemented, and it is where the
`getTeams` join and the `result`-over-`state` correction live. `lolesports.md`, `valorant.md`, and
`cs2-blast.md` are kept as the evidence that shaped the interface, not as pending work; `cs2-blast.md`
has one unreviewed finding about `/brackets` that is now also recorded in SPEC §4.

`docs/sources/riot-rest-parameters.md` is the parameter reference for the Riot REST endpoints this
project touches — every claim in it cites the probe id that measured it, and `npm run probe --
<group>` re-derives the numbers live. `docs/DATA_FLOW.md` is the wire-to-domain map: which JSON
field becomes which `SourceMatch`/`SourceTeam`/`SourceLeague` field, with diagrams for the
three-endpoint join and where each `WarningCode` fires. Read it before touching the adapter
boundary — it is where "what does `getTeams` actually supply" is answered without re-reading
`parse.ts` and `teams.ts` line by line.

`src/core/source.ts` is **final for Stage 0**, not a draft. `config/leagues.json` is the coverage
decision and the manual team overrides; it cannot be derived from the API and changes on a product
decision. `docs/CLAUDE_CODE_PLAYBOOK.md` is how to run a session — it was rewritten 2026-08-11 and its
stage numbers now match SPEC §8.

## Stack

TypeScript throughout. Express (JSON API) + React (web). PostgreSQL. Redis. Docker Compose local.
Nothing reads Postgres or Redis yet — stage 1 is the first consumer.

## Conventions

- Domain types live in one place, shared between server and client.
- Source DTOs are separate types from domain models. Map explicitly at the adapter boundary.
- Prefer pure functions for calendar composition, stream resolution, and notification-due calculation
  — the three places most likely to be subtly wrong. Calendar composition takes (follows, selections,
  matches); it is still pure, the override rules just add an input.
- Every ingestion edge case gets a named test: TBD opponents, reschedules, cancellations, best-of
  changes, team renames, a source returning zero rows.
- **Fixture-backed tests inject a fixed reference clock** — the date the fixture was captured — and
  never read system time. A fixture's matches are frozen in time, so "the next 7 days" only means
  anything relative to capture. Without this the same fixture returns nothing a few weeks later, and
  the test fails for a reason that has nothing to do with the code. Applies to every adapter.
- A test may assert a measured number only if the committed fixtures can produce it. Figures from the
  full uncommitted capture belong in comments, labelled.

## Verification

```
npm run typecheck && npm run test && npm run lint
```

Then state which SPEC.md acceptance criterion is now satisfied, and how you verified it.

Useful for a real end-to-end check against the committed fixture:

```
npx tsx src/cli/next-matches.ts --league lck --days 7 --now 2026-08-09T00:00:00Z
```

`--now` is not optional in spirit: without it the CLI reads the system clock against a frozen fixture
and prints nothing, for a reason unrelated to the code. It warns when you omit it.
