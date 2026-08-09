# CLAUDE.md

Cross-title esports match calendar. Users follow leagues and teams; matches appear in a web
calendar, an ICS feed, and later a native iOS app, with stream links and pre-match notifications.
League of Legends is the first title implemented — it is not the product.

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

## Read before designing anything

`docs/sources/lolesports.md`, `lolesports-rest.md`, `valorant.md`, `cs2-blast.md`. Three real
sources were probed to shape the interface. `src/core/source.ts` is a **draft** — challenging it
against those notes is Stage 0's job, and a place it does not fit is a finding to report, not an
obstacle to work around.

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
