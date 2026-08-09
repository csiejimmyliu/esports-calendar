# Claude Code Playbook

One stage per session. Plan before code. Verify before moving on.

---

## Setup (once)

```bash
mkdir esports-calendar && cd esports-calendar
git init
mkdir -p docs
# CLAUDE.md → repo root
# SPEC.md, this file → docs/
git add -A && git commit -m "docs: spec and working agreement"
claude
```

Do **not** run `/init` yet. It generates CLAUDE.md by scanning an existing codebase; there is no
codebase, and the hand-written file is better than anything it would infer. Run it around Stage 3
and merge in whatever it finds worth keeping.

---

## Session loop

1. `/clear` — stale context from the previous stage is a liability.
2. Plan mode (`Shift+Tab`).
3. Paste the stage prompt.
4. **Read the plan properly.** Highest-leverage minute you will spend — most bad outcomes are
   visible here and nearly free to fix.
5. Approve or correct. If you correct a wrong assumption, decide whether it belongs in CLAUDE.md.
6. Let it implement — **on its own branch, `stage-<n>-<short-name>`.**
7. Ask for verification *output*, not a verification *claim*.
8. Fresh-context review: `Use a subagent to review the Stage 2 diff against docs/SPEC.md §2 and report gaps only.`
9. The agent commits to the stage branch. **You merge. The agent never touches `main`.**

### Why the branch

A stage is the unit of work, so it should also be the unit of undo. On a shared `main` a stage
that turns out to be wrong has to be picked apart commit by commit; on its own branch it is one
`git branch -D` and the history is clean.

It also puts a human decision between "the agent says it verified this" and "this is now the
project". That gap is where step 7 actually gets enforced.

```bash
git checkout -b stage-3-web-calendar     # before implementing
# ... verify ...
git checkout main && git merge --ff-only stage-3-web-calendar   # you, not the agent
```

---

## Session 0 — kickoff

Paste as the first message, in plan mode:

```
Read CLAUDE.md, docs/SPEC.md, and all four notes in docs/sources/ before responding.

Greenfield TypeScript project. Do not write any code yet.

This session is Stage 0 only: finalise the source adapter interface, then implement the first
adapter (Riot GraphQL for LoL). No database, no web server. Success is a CLI printing the next
7 days of LCK matches in correct Asia/Taipei time, with a golden fixture and a parser test.

Before planning, do two things:

1. Tell me anything in SPEC.md that is underspecified, contradictory, or that you would have to
   guess at to implement Stage 0. Ask rather than assume.

2. Critique the draft interface in src/core/source.ts against all three probed sources.
   Specifically:
   - Does the two-phase listScopes/fetchMatches shape actually work for BLAST, given it has
     no tournament-listing endpoint?
   - BLAST needs two endpoints to produce one Match, because state lives only in /brackets.
     Should fetchMatches hide that, or should the interface admit multi-request fetches?
   - Riot GraphQL returns composite team ids while Riot REST returns plain ones. Where does
     splitting belong?
   - Are SourceCapabilities the right set, or is something missing?

   Where the draft does not fit, say so plainly. That is the finding. Do not bend a source's
   data to fit the interface.

Then plan: scaffolding, the finalised interface, the Riot GraphQL adapter, runtime validation
with zod, golden fixture wiring, timezone handling, and the CLI entry point. Include how you
verify each piece.

Do not implement until I approve.
```

Two things this is doing on purpose: forcing questions before planning (a model allowed to assume
will assume, and the assumptions resurface as rework), and naming the load-bearing decision so the
session's attention goes where it matters.

---

## Stage prompt template

```
Read CLAUDE.md and docs/SPEC.md §<section> before responding.

This session is Stage <n> only: <one-sentence goal>.
Acceptance criterion (SPEC.md §8): <paste the row>.

Constraints most likely to be violated here:
- <1-3 specific ones>

Plan first. Tell me:
- what you will build
- what you will deliberately NOT build, and why
- how you will verify the acceptance criterion
- anywhere SPEC.md is wrong or incomplete

Do not implement until I approve.
```

The "deliberately NOT build" line earns its keep — it surfaces scope creep at plan time, when it
costs nothing.

---

## Adding a new source (the repeatable workflow)

This is the operation you will do most often, so make it cheap. The agent does the exploration;
the output is deterministic code.

1. **Explore** — separate session, read-only:
   `Open <site>, inspect its network traffic, and report the endpoints that back the schedule page: URLs, required headers, response shape, pagination, and how streams are represented. Do not write code yet.`
2. **Capture** — save a real response to `fixtures/<source>/schedule.json`. Commit it.
3. **Write the adapter** against the fixture, conforming to the existing interface.
4. **Map identity** — how this source's team ids reconcile into `external_ref`.
5. **Add a canary** — a semantic assertion for this source.
6. **Verify** — parser test green against the fixture, and one live call matching it.

Never let the agent parse pages at runtime. If a site can only be read by an agent, that is a
signal the source is a bad fit, not a reason to put an agent in the sync path.

---

## Stage-specific notes

**Stage 1** — Require the idempotency test *before* the sync implementation: "Write the test that
runs sync twice and asserts zero duplicate rows, then make it pass." Also require the deliberately-
broken-source test and the empty-parse canary. A model will not handle TBD opponents or zero-row
responses until forced.

**Stage 2** — The de-duplication case (following both LCK and T1) is the one to call out. Ask for
the filter as a pure function with a table-driven test.

**Stage 3** — Agenda view alone first, then grid views. Grid calendars eat entire sessions if you
let them go first. Spoiler-free must be built in from the start; retrofitting means auditing every
render path.

**Stage 4** — The hard part is not OAuth, it is migrating anonymous local subscriptions into the
account without duplicating or clobbering. Ask for that test first.

**Stage 5** — Verification is manual and non-negotiable: subscribe in real Google Calendar, change
a match time in the DB, confirm the event **updates** rather than duplicating. That is the
UID/SEQUENCE contract, and it is silently broken in most ICS implementations.

**Stage 6** — Insist on the sweeper design (SPEC §6), not pre-enqueued delayed jobs. If the agent
proposes enqueue-on-create, push back: ask it to enumerate the reschedule cancellation cases it
would then have to handle. The sweeper deletes that entire category.

**Stage 7** — The exam. Frame it as such: "Add <title> by writing only a new adapter. If you need
to change anything in the core, stop and tell me what and why — that is the finding, not a
blocker to work around."

**Stage 8** — Instrument cache hit ratio *before* adding the cache so you have a before number.
Require the subscription-hash cache key explicitly; left alone, a model will cache per user, which
works but misses the point.

**Stage 11** — Different mode entirely. Prompt for measurement, not features: "Load test the read
path, add a read replica, re-measure. Report the delta honestly, including if it is zero."

---

## Failure modes

| Symptom | Fix |
|---|---|
| Implementation drifts from approved plan | CLAUDE.md says stop and re-plan. Enforce it out loud. |
| "Tests pass" with no output | Ask for the actual command output. Every time, until it stops. |
| Context bloat mid-session | Stage was too large. `/clear` and split it. |
| Unbounded repo exploration | Scope the read, or hand it to a subagent so it does not flood main context. |
| Silent dependency additions | Check `package.json` in the diff. |
| Agent proposes runtime parsing | Hard no. Adapter code only. |

---

## Notes to keep

You are building this partly to learn Chapter 1. At each stage that adds a brick, answer:

1. What bottleneck did this brick address?
2. How did I measure that the bottleneck existed?
3. How did I measure that the brick helped?

If you cannot answer (2), you added the brick for the diagram, not for the system. That is
occasionally fine — but it should be a conscious choice, and labeled as one.
