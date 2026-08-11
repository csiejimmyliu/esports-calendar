# CLAUDE.md

League of Legends esports match calendar. Users follow leagues and teams; matches appear in a web
calendar, an ICS feed, and later a native iOS app, with stream links and pre-match notifications.
The target: every match lolesports.com shows, in one subscribable calendar.

**LoL only, decided 2026-08-09.** VALORANT and CS2 adapters are off the roadmap. The cross-title
*design* stays — `SourceCapabilities`, the `game` field, optional `league`, the two-phase scope
shape, and all four notes in `docs/sources/`. Keeping them costs nothing and they are why the
interface is not a transcription of Riot's response shape. See SPEC §0.

**Read `docs/SPEC.md` before planning anything.** It is the source of truth. If your plan
contradicts it, say so explicitly rather than silently deviating.

## Working agreement

- Plan mode for anything beyond a single-file change. Show me the plan before editing.
- **If execution diverges from the approved plan, stop and re-enter plan mode.**
- Evidence before claims. Never say "tests pass" or "this works" without showing the output.
- One stage at a time (SPEC §8). Do not start the next unprompted.
- Tell me when you find a wrong assumption in this file or SPEC.md. Do not edit SPEC.md
  without asking.
- Ask before adding a dependency.

## Non-negotiable constraints

- **API-first.** Every capability is available over JSON API. No web-only logic — a native iOS
  client must be able to do everything the web can.
- **Source isolation.** User requests never trigger an upstream fetch. Only the sync worker
  calls upstream.
- **Adapter boundary.** No source's URLs, credentials, identifiers, or response shapes leak
  above the adapter interface.
- **Agents are build-time only.** An agent may explore a site and write an adapter. An agent is
  never part of the runtime sync path. Agent output is code, not data.
- **Golden fixtures.** Every source adapter has a snapshotted real response and a parser test
  against it. No adapter is complete without one.
- **Every fixture records the request that produced it** in a `<fixture>.meta.json` sidecar: full
  URL, every query and path parameter, non-secret headers, and the capture date. A fixture whose
  parameters are unknown cannot be re-captured or compared against live, and a mismatch between
  it and what the client actually sends is invisible — `rest_getSchedule.json` was captured under
  `hl=zh-TW` while the client pins `hl=en-US`, and nothing surfaced that until a sidecar was
  written. State plainly which fields were verified and which were inferred.
- **Fixtures are verbatim, with exactly one exception.** A field that SPEC explicitly excludes as
  personal data may be removed; the sidecar must then say `verbatim-except-<fields>` and record the
  before/after row counts. The verbatim rule protects test fidelity, and dropping a field the
  parser is required to discard costs none — whereas real players' names in a public repo that
  says it does not collect player data is a substantive problem. `getTeams` carries a `players`
  roster per team and is the first case. This is not licence to trim inconvenient fields.
- **Team identity is a narrowed join, not a lookup.** Riot names teams in `getSchedule` and
  identifies them in `getTeams`; they are joined by `code`. Unnarrowed, 27 codes collide. Narrowing
  the team table to major leagues is necessary and *not sufficient* — resolution must also be gated
  on the tier of the league the match is played in, or academy squads inherit their parent's id
  (11 such sides in one captured day). An ambiguous code resolves to nothing and warns.
- **Semantic canaries, not liveness checks.** Scrapers fail by returning HTTP 200 with zero rows.
  Health checks must assert content ("LCK has ≥1 match in the next 14 days"), not status codes.
  Confirmed in the wild: BLAST returns 200 + `[]` for an unknown tournament slug, indistinguishable
  from a real tournament with nothing scheduled.
- **Enumerate, never assume closed sets.** `type: "show"` events carry no `match` object. A fixture
  proves existence, never absence — warn on unknown enum values rather than throwing or dropping.
- **Partial failure isolation.** One broken source must not fail the sync run or empty the
  calendar for other titles.
- **Idempotent ingestion.** Every sync write is an upsert. Running sync twice is a no-op.
- **Internal canonical ids.** Source ids are aliases in `external_ref`, never primary keys.
  Riot's GraphQL team ids are composite (`{matchId}:{teamId}`) — split before use, or every match
  creates a new team. Ids are opaque strings: Riot uses numeric snowflakes, BLAST uses UUIDs.
- **Declared capabilities, not assumed uniformity.** Sources differ in capability, not just field
  names. BLAST has no global schedule endpoint, no league tier, and no state field.
- **Parse timestamps per field.** Zone markers are inconsistent even within one object.
- **UTC in storage.** Timezone conversion only at the render boundary.
- **Stateless web tier.** No session or user state in process memory.
- **Spoiler-free by default.** No score or winner in any default view, and never in ICS `SUMMARY`.

## Out of scope — do not build

Player, coach, roster, transfer, or contract data. Live match state, live scores, in-progress
badges. Match statistics, picks/bans, VODs, standings, brackets. Tier 2/3 or non-broadcast events.

These are deliberate exclusions. If a task seems to need one, ask rather than assume.

## How source notes are written

**Every speculative claim states where its confidence comes from.** "Inferred from a 5-row
cross-check" and "verified exhaustively against all 80 events, zero exceptions" are different
claims and must not be written in the same voice. Label the basis: sampled, cross-checked,
exhaustive-over-one-capture, or assumed. State the sample size.

This is not documentation hygiene, it is a bug class. `lolesports-rest.md` described inferring
match state from `result == null` as a "partial workaround… inference, not data". That wording
was written from a five-id cross-check. Checking all 80 events showed the signal is exact — 7 of
7 unplayed matches have a null result, 0 of 73 played ones do. The adapter had already been
written to merely *warn* about the bad state field instead of correcting it, because the note's
hedging made correction sound unfounded. **The prose talked the implementation out of the right
answer.**

Corollary: when a claim is upgraded from sampled to verified, encode the evidence as a test, not
only as a paragraph. An exhaustive check is exhaustive over one capture, and the next capture is
not bound by it.

## Read before designing anything

`docs/sources/lolesports-rest.md` first — it is the only source now implemented, and it is where
the `getTeams` join, the `result`-over-`state` correction, and the `displayPriority` correction
live. `lolesports.md`, `valorant.md`, and `cs2-blast.md` are kept as the evidence that shaped the
interface, not as pending work.

`src/core/source.ts` is **final for Stage 0**, no longer a draft. `config/leagues.json` is the
hand-maintained tier table and the manual team overrides; it cannot be derived from the API and
changes on a product decision.

## Stack

TypeScript throughout. Express (JSON API) + React (web). PostgreSQL. Redis. Docker Compose local.

## Conventions

- Domain types live in one place, shared between server and client.
- Source DTOs are separate types from domain models. Map explicitly at the adapter boundary.
- Prefer pure functions for subscription filtering, stream resolution, and notification-due
  calculation — the three places most likely to be subtly wrong.
- Every ingestion edge case gets a named test: TBD opponents, reschedules, cancellations,
  best-of changes, team renames, a source returning zero rows.
- **Fixture-backed tests inject a fixed reference clock** — the date the fixture was captured —
  and never read system time. A fixture's matches are frozen in time, so "the next 7 days" only
  means anything relative to capture. Without this the same fixture returns nothing a few weeks
  later, and the test fails for a reason that has nothing to do with the code. Applies to every
  adapter, not just the first one.

## Verification

```
npm run typecheck && npm run test && npm run lint
```

Then state which SPEC.md acceptance criterion is now satisfied, and how you verified it.
