# esports-calendar

A cross-title esports match calendar. Follow leagues and teams; see only the matches you care
about, in a web calendar, a subscribable ICS feed, and later a native iOS app — each match with a
stream link and an optional pre-match notification.

League of Legends is the first title implemented. It is not the product.

## Status

Pre-Stage-0. Three sources have been probed and documented; no application code exists yet.

## Where to start

| File | What it is |
|---|---|
| `docs/SPEC.md` | Source of truth: requirements, domain model, architecture, stages |
| `CLAUDE.md` | Working agreement and non-negotiable constraints |
| `docs/CLAUDE_CODE_PLAYBOOK.md` | How to drive the build, stage by stage |
| `docs/sources/*.md` | What each upstream actually returns, verified against real responses |
| `src/core/types.ts` | Normalized domain model |
| `src/core/source.ts` | Source adapter interface — **draft**, to be challenged in Stage 0 |

## Why the interface looks the way it does

Three sources were probed before any design work:

- **Riot LoL** — GraphQL persisted query and a parallel REST API. Global schedule, league tier,
  explicit state, no stream URLs.
- **Riot VALORANT** — the same backend, one path segment apart.
- **BLAST CS2** — no global schedule endpoint, no league tier, no state field, but per-match
  stream URLs. Inverted conventions for TBD opponents and for series that end early.

BLAST is why fetching is two-phase, why `league` is optional, and why capabilities are declared
rather than assumed. Designing against Riot alone would have produced an interface shaped exactly
like Riot's response, which is not an abstraction.

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
