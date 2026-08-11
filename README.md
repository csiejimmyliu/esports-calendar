# esports-calendar

A League of Legends esports match calendar. Follow leagues and teams; see only the matches you
care about, in a web calendar, a subscribable ICS feed, and later a native iOS app — each match
with a stream link and an optional pre-match notification.

The target: every match lolesports.com shows, in one subscribable calendar.

## Status

**Stage 0.5 complete.** One source adapter (`riot-rest-lol`) with golden fixtures, semantic
canaries, and team identity via the `getTeams` master table. A CLI prints upcoming matches with
resolved team ids. No database, no server, no web UI yet.

Scope was narrowed to LoL only on 2026-08-09 (SPEC §0). The cross-title interface design is kept;
the VALORANT and CS2 adapters are not on the roadmap.

## Where to start

| File | What it is |
|---|---|
| `docs/SPEC.md` | Source of truth: requirements, domain model, architecture, stages |
| `CLAUDE.md` | Working agreement and non-negotiable constraints |
| `docs/CLAUDE_CODE_PLAYBOOK.md` | How to drive the build, stage by stage |
| `docs/sources/*.md` | What each upstream actually returns, verified against real responses |
| `src/core/types.ts` | Normalized domain model |
| `src/core/source.ts` | Source adapter interface — final for Stage 0 |
| `config/leagues.json` | Hand-maintained league tiers and team overrides; cannot be derived from the API |

## Why the interface looks the way it does

Three sources were probed before any design work:

- **Riot LoL** — GraphQL persisted query and a parallel REST API. Global schedule, league tier,
  explicit state, no stream URLs.
- **Riot VALORANT** — the same backend, one path segment apart.
- **BLAST CS2** — no global schedule endpoint, no league tier, no state field, but per-match
  stream URLs. Inverted conventions for TBD opponents and for series that end early.

BLAST is why fetching is two-phase, why `league` is optional, and why capabilities are declared
rather than assumed. Designing against Riot alone would have produced an interface shaped exactly
like Riot's response, which is not an abstraction. Those adapters are now shelved, but the shape
they forced is kept — it cost nothing to keep and a session to unpick.

## Running it

```bash
npx tsx src/cli/next-matches.ts --league lck --days 7 --tz Asia/Taipei --now 2026-08-09T00:00:00Z
```

Reads the committed fixture by default; `--live` goes upstream. `--now` is required offline for a
meaningful answer, because a fixture's matches are frozen at its capture date.

## Setup

```bash
npm install
cp .env.example .env
docker compose up -d
npm run typecheck && npm run test
```

## Data sources and attribution

Upstream APIs are undocumented and unofficial. Poll politely, back off, identify the client, cache
aggressively, and never proxy user traffic upstream. This repository is open source; the request
volume it generates should be defensible to the people running those services.

## License

MIT.
