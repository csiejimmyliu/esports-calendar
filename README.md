# esports-calendar

A League of Legends esports match calendar. Two surfaces: an **overview** of every covered match,
filterable by league and team; and a **personal calendar** of the matches you chose. Matches get onto
your calendar two ways at once — **follow** a league or a team and its matches arrive automatically, or
**pick** individual matches by hand — and you can still drop single matches from a league you follow.
Later: reminders, and a stream link per match with your own provider order.

**Coverage is eight leagues**: Worlds, MSI, First Stand, LCK, LPL, LEC, LCS, LCP. That is a product
decision (`config/leagues.json`), not an API limitation, and it is expected to widen.

## Status

**Stage 1b complete.** Schema, source registry, identity crosswalk, idempotent sync, and now source
health + canary scheduling (`docs/SPEC.md` §8 stage 1 is split into 1a/1b there — 1a landed the sync
worker, 1b landed what happens when a source degrades: a preserved-not-erased team identity across a
transient `getTeams` outage, a parser drop that is never read as a cancellation, per-scope failure
isolation, a genuinely no-op second run, and `source_health`/`sync_run`/`canary_result` recording).

Before that: one source adapter (`riot-rest-lol`) with golden fixtures, semantic canaries, and team
identity via the `getTeams` master table (Stage 0–0.8).

**Postgres is required now.** `docker compose up -d db`, then `DATABASE_URL=... npm run migrate` and
`npm run sync -- --source riot-rest-lol --now <ISO instant>` (`--live` goes upstream instead of the
committed fixture; needs `RIOT_ESPORTS_API_KEY`, see `.env.example`). `npm run test:db` runs the
DB-backed suite against the same instance — `npm run test` alone does not exercise it.

**Stage 2 complete**, split into 2a and 2b. 2a is calendar composition as a pure function
(`src/core/calendar.ts`) plus `follow`/`selection` persistence and the anonymous identity row; 2b is
the Express JSON API over it — see **`docs/API.md`**. Anonymous users are addressed by an opaque
bearer token in `Authorization`, never by `app_user.id` and never by a cookie; SPEC §2 FR-1 records
why and what risk that accepts.

```bash
DATABASE_URL=... npm run serve          # :3000, or set PORT
curl -sX POST localhost:3000/v1/anon-users
curl -s "localhost:3000/v1/matches?anchor=2026-08-12T00:00:00Z&limit=5"
```

**No web UI, no ICS, no notifications, no CI.** Stage 3 (the two web surfaces) is next.

Scope was narrowed to LoL only on 2026-08-09; the requirements and stage plan were rewritten from the
owner's own statement on 2026-08-11 (SPEC §0, §8). The cross-title interface design is kept and marked
as a deferred capability; VALORANT and CS2 adapters are not on the roadmap until the LoL calendar is
complete.

## Where to start

| File | What it is |
|---|---|
| `docs/SPEC.md` | Source of truth: requirements, domain model, architecture, stages |
| `CLAUDE.md` | Working agreement and non-negotiable constraints |
| `docs/CLAUDE_CODE_PLAYBOOK.md` | How to run a session, stage by stage |
| `docs/sources/*.md` | What each upstream actually returns, with the confidence basis of every claim |
| `fixtures/README.md` | Fixture rules: verbatim, two exceptions, and why every fixture has a sidecar |
| `src/core/types.ts` | Normalized domain model |
| `src/core/source.ts` | Source adapter interface — final for Stage 0 |
| `config/leagues.json` | The coverage decision and the manual team overrides; cannot be derived from the API |

## Why the interface looks the way it does

Three sources were probed before any design work:

- **Riot LoL** — a REST API and a GraphQL persisted query. Global schedule, no usable league tier, no
  trustworthy state field, no stream URLs. REST is the one implemented; GraphQL was dropped once REST
  turned out to supply team ids and exact state.
- **Riot VALORANT** — the same backend, one path segment apart.
- **BLAST CS2** — no global schedule endpoint, no league tier, no state field, but per-match stream
  URLs. Inverted conventions for TBD opponents and for series that end early.

BLAST is why fetching is two-phase, why `league` is optional, and why capabilities are declared rather
than assumed. Designing against Riot alone would have produced an interface shaped exactly like Riot's
response, which is not an abstraction. Those adapters are shelved; the shape they forced is kept, and
what keeping it costs is written down rather than waved away (see the comment on `GameSlug`).

## Running it

```bash
npm install
npx tsx src/cli/next-matches.ts --league lck --days 7 --tz Asia/Taipei --now 2026-08-09T00:00:00Z
```

Reads the committed fixture by default; `--live` goes upstream and needs `RIOT_ESPORTS_API_KEY` set.
`--now` is required offline for a meaningful answer, because a fixture's matches are frozen at its
capture date — omit it and the CLI warns and prints nothing.

Any of the five regional leagues works: `lck`, `lpl`, `lec`, `lcs`, `lcp`. The international slugs
(`worlds`, `msi`, `first_stand`) have no matches in the committed capture, which is their normal state
for most of the year.

To re-capture a fixture together with its sidecar:

```bash
RIOT_API_KEY=... npm run capture -- getTeams fixtures/riot-lol/rest_getTeams_full
```

## Verification

```bash
npm run typecheck && npm run test && npm run lint
```

## Data sources and attribution

Upstream APIs are undocumented and unofficial. Poll politely, back off, identify the client, cache
aggressively, and never proxy user traffic upstream. This repository is open source; the request volume
it generates should be defensible to the people running those services.

No player, coach or roster data is collected. That is enforced at the parser rather than merely stated:
the `players` field Riot returns on every team is undeclared in the schema and stripped at the adapter
boundary, and the committed fixtures contain no player names.

## License

MIT.
