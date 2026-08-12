# Claude Code Playbook

How to run a session on this repo. One stage per session. Plan before code. Verify before moving on.

> **Rewritten 2026-08-11.** The previous version was written before the scope decision and had gone
> comprehensively stale: its kickoff prompt told the agent to implement the Riot **GraphQL** adapter
> (dropped), it called `src/core/source.ts` a draft (it is final for stage 0), and three of its
> stage-specific notes pointed at the wrong stage after CS2 moved from 7 to the end. The stage prompt
> templates for already-finished work are gone; the workflow and the notes are kept, renumbered
> against the current SPEC §8, and one of them is corrected outright — see stage 9.

---

## Session loop

1. `/clear` — stale context from the previous stage is a liability.
2. Plan mode.
3. State the stage and its acceptance criterion (template below).
4. **Read the plan properly.** Highest-leverage minute in the session — most bad outcomes are visible
   here and nearly free to fix.
5. Approve or correct. If you correct a wrong assumption, decide whether it belongs in `CLAUDE.md`.
6. Let it implement — **on its own branch, `stage-<n>-<short-name>`.**
7. Ask for verification *output*, not a verification *claim*.
8. Fresh-context review: `Use a subagent to review the stage 2 diff against docs/SPEC.md §2 and report gaps only.`
9. The agent commits to the stage branch. **You merge. The agent never touches `main`.**

### Why the branch

A stage is the unit of work, so it should also be the unit of undo. On a shared `main` a stage that
turns out to be wrong has to be picked apart commit by commit; on its own branch it is one
`git branch -D` and the history is clean.

It also puts a human decision between "the agent says it verified this" and "this is now the project".
That gap is where step 7 actually gets enforced.

```bash
git checkout -b stage-3-web-surfaces               # before implementing
# ... verify ...
git checkout main && git merge --ff-only stage-3-web-surfaces   # you, not the agent
```

---

## Stage prompt template

```
Read CLAUDE.md and docs/SPEC.md §<section> before responding.

This session is stage <n> only: <one-sentence goal>.
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

Two things this does on purpose. The "deliberately NOT build" line surfaces scope creep at plan time,
when it costs nothing. And "anywhere SPEC.md is wrong" is not politeness — SPEC has been wrong before,
in ways that shaped code (see the note at the top of `docs/sources/lolesports-rest.md` about prose
talking an implementation out of the right answer).

---

## Adding a new source (the repeatable workflow)

Deferred indefinitely — LoL is the only title until the calendar is complete (SPEC §0). Kept because
it is the operation the whole adapter interface exists to make cheap, and because stage 11 is the exam
it describes.

1. **Explore** — separate session, read-only:
   `Open <site>, inspect its network traffic, and report the endpoints that back the schedule page: URLs, required headers, response shape, pagination, and how streams are represented. Do not write code yet.`
2. **Capture** — save a real response with its sidecar: `npm run capture -- <endpoint> <outPath>`.
   Every fixture records the request that produced it, or it cannot be re-captured or compared
   against live.
3. **Write the adapter** against the fixture, conforming to the existing interface.
4. **Map identity** — how this source's ids reconcile into `external_ref`.
5. **Add a canary** — a semantic assertion for this source, and one that survives an off-season.
6. **Verify** — parser test green against the fixture, and one live call matching it.

Never let the agent parse pages at runtime. If a site can only be read by an agent, that is a signal
the source is a bad fit, not a reason to put an agent in the sync path.

---

## Stage-specific notes

Numbered against the current SPEC §8. Stages 0, 0.5, 0.6, 0.7, and 0.8 are done.

**Stage 0.8 — API boundary survey.** Also discovered mid-session rather than planned: a Stage 1
alignment check surfaced that no parameter or boundary claim about the Riot REST API had actually
been measured — `getTeams`'s "no other parameters" line was an assumption in the declarative
voice, three named endpoints (`getTournamentsForLeague`, `getStandings`, `getCompletedEvents`) had
never been called by anything, and the entire team-identity name join rested on two fixtures
captured three days apart under different locales. Require every claim to cite a probe id, and
require the probe log itself to be committed (`docs/probes/riot-rest/*.probe.json`), not just its
prose summary — the same "encode the claim as a test, not only as a paragraph" instinct as 0.7's
`crawl-incomplete` field, applied to documentation instead of code. The one probe worth insisting
on before any other: a same-instant locale A/B on `getTeams`, because a mismatch there would have
been a Stage 1 blocker for the whole team-identity design, not a footnote.

**Stage 0.7 — schedule pagination.** Discovered as a blocker while preparing Stage 1, not planned in
advance: `fetchMatches` was one unparameterised `getSchedule` call, returning roughly 1.5 days of
future, which cannot back FR-2's "every covered match past and future". Require the pagination
parameter to be *measured against the live API*, not assumed from a field being present and
non-null — that was exactly the mistake the pre-0.7 `timeWindow` comment made. A model will
naturally want to bound the crawl by a hardcoded day count; require it to stop on
`pages.newer === null` instead, since page width is a function of match density, not time. Require
the partial-crawl test (a middle page failing) before the happy path, the same idempotency-first
instinct as Stage 1's own note below — NFR-4 (partial failure isolation) says a truncated crawl must
still return what it has, not throw the near-now slice away.

**Stage 1 — schema and sync.** Require the idempotency test *before* the sync implementation: "write
the test that runs sync twice and asserts zero duplicate rows, then make it pass." Also require the
deliberately-broken-source test. A model will not handle TBD opponents or zero-row responses until
forced. The canary work here is scheduling, not invention — the assertions already exist and are unit
tested; what stage 1 adds is running them and recording the outcome in `source_health`.

**Stage 2 — follow and selection.** The cases to call out are the override rules in SPEC §2 FR-1, not
de-duplication. De-duplication is the easy half and a model will get it; what it will miss is that
unfollowing must not delete hand-picked matches, and that an `excluded` row survives both the match
finishing and the follow being removed. Ask for the whole thing as a pure function with a table-driven
test, and ask for NFR-8 as a test too.

**Stage 3 — the two surfaces.** Agenda view alone first, then grid views; grid calendars eat entire
sessions if you let them go first. Two things must be right from the start rather than retrofitted:
spoiler-free (retrofitting means auditing every render path) and the filter/follow distinction (a
filter must issue no write — SPEC §2 FR-2). Past matches are in scope, so the default view shows
finished matches without revealing scores.

**Stage 4 — OAuth.** The hard part is not OAuth, it is migrating anonymous state into the account
without duplicating or clobbering. There are now **two** tables to migrate, not one. Ask for that test
first.

**Stage 5 — ICS.** Verification is manual and non-negotiable: subscribe in real Google Calendar,
change a match time in the DB, confirm the event **updates** rather than duplicating. That is the
UID/SEQUENCE contract and it is silently broken in most ICS implementations. `DTEND` comes from the
duration estimate in SPEC §1 — make sure the code says it is an estimate.

**Stage 6 — notifications.** Insist on the sweeper design (SPEC §6), not pre-enqueued delayed jobs. If
the agent proposes enqueue-on-create, ask it to enumerate the reschedule cancellation cases it would
then have to handle. The sweeper deletes that entire category.

**Stage 7 — iOS.** The real exam for NFR-1. Frame it that way: "build the client against the existing
JSON API. If you need an API change to make this comfortable, stop and tell me what and why — that is
a finding about the API, not a blocker to work around." Anything you have to add is evidence the API
was secretly web-shaped.

**Stage 8 — observability, before the cache.** Get the before-numbers: per-source health, staleness
age, p95, and the actual serialised size of the global snapshot. SPEC §6 asserts that snapshot is
small and **has never measured it**; this is where that gets settled.

**Stage 9 — cache and CDN.** ⚠️ The previous version of this note required "the subscription-hash
cache key". **That is now known not to work** — per-match include/exclude makes each user's feed
effectively unique, so hashing the follow set buys nothing. See SPEC §6 for the layering that does
work: cache the shared snapshot hard, keep the per-user selection set tiny, render the composition.
Left alone a model will cache per user, which works and misses the point in a different direction.

**Stage 10 — the study track.** Different mode entirely. Prompt for measurement, not features: "load
test the read path, add a read replica, re-measure. Report the delta honestly, including if it is
zero." A negative result is the expected result and is the deliverable.

**Stage 11 — a second title.** "Add <title> by writing only a new adapter. If you need to change
anything in the core, stop and tell me what and why — that is the finding, not a blocker to work
around." Read the `/brackets` warning in SPEC §4 first if the title is CS2.

---

## Failure modes

| Symptom | Fix |
|---|---|
| Implementation drifts from approved plan | CLAUDE.md says stop and re-plan. Enforce it out loud. |
| "Tests pass" with no output | Ask for the actual command output. Every time, until it stops. |
| A measured number quoted from an earlier draft | Re-measure. Numbers go stale when config changes; see the coverage narrowing of 2026-08-11, which moved every team-table figure in the repo. |
| Context bloat mid-session | Stage was too large. `/clear` and split it. |
| Unbounded repo exploration | Scope the read, or hand it to a subagent so it does not flood main context. |
| Silent dependency additions | Check `package.json` in the diff. |
| Agent proposes runtime parsing | Hard no. Adapter code only. |
| A capability flag that overstates the code | Pin the flag to the behaviour in a test, as `timeWindow` is. |

---

## Before adding any system-design brick

At each stage that adds one, answer:

1. What bottleneck did this brick address?
2. **How did I measure that the bottleneck existed?**
3. How did I measure that the brick helped?

If you cannot answer (2), you added the brick for the diagram, not for the system. That is
occasionally fine — but it should be a conscious choice, and labelled as one. SPEC §7 lists which
bricks this workload actually earns and gives each a "measure first" column; §6 contains one
conclusion that currently fails this test and says so.
