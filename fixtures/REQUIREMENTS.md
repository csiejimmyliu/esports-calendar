# What each fixture needs to contain

This is a checklist for the day someone recaptures every `riot-lol/` fixture together under one
locale and one date to close the `hl=zh-TW` vs `hl=en-US` inconsistency `fixtures/README.md`'s Open
section describes. Read that file first — this one assumes you already know why fixtures are frozen
test inputs, and what the recapture ritual (`capture:refresh` / `capture:check`) does.

## How to use this

For each fixture: pull a fresh capture, check it against the list below, and decide per fixture
whether it can replace the committed one. A fixture that satisfies its list can be swapped in. One
that doesn't should stay put — a locale fix is not worth trading away test coverage for.

**Every condition here is written as an existence check — "does at least one row like this exist" —
not as an exact count or a specific id.** The tests that currently back these fixtures mostly assert
exact numbers and hardcoded ids (`toHaveLength(80)`, `externalId === '117047583684384478'`, and so
on), because those are the true numbers of the specific capture they were written against. That is
an artefact of how they were written, not a real requirement of the data — nothing about the
`lossy-state` correction actually needs *exactly* 3 examples of it, it needs *at least one*. So this
document states the real requirement, and updating the tests from "the count from one specific
capture" to "the first row that matches this condition" is the deliberate next step *after* a
replacement fixture is chosen — checking a fresh capture against this list and rewriting the tests
to match it are two stages of the same job, not this list plus a separate, someday task.

**Basis**: every condition below was read directly out of the current test files, not inferred —
`tests/riot-rest-parse.test.ts`, `tests/riot-rest-adapter.test.ts`, `tests/cli-select.test.ts`,
`tests/riot-team-identity.test.ts`. This is a sampled reading of what those files currently assert,
not an exhaustive line-by-line audit; a condition can be missing from this list without the list
being wrong, just incomplete. Re-check against the tests, not just this document, when in doubt.

## `rest_getSchedule.json`

The busiest fixture — read by four test files. What a replacement needs to contain:

- At least one match where both sides have `result: null` (unplayed), and at least one where neither
  side does (played) — the "unplayed vs. played" split the state correction rests on.
  (`tests/riot-rest-parse.test.ts`, "the null-result signal is exact across the whole fixture")
- At least one match where Riot's `state` says `completed` but at least one side's `result` is
  `null` — a **lossy-state** case, where Riot's own state field is wrong and the parser corrects it.
  See "What is a lossy-state case" below if this term is unfamiliar.
  (`tests/riot-rest-parse.test.ts`, "corrects TBD + completed to unstarted...")
- At least one match that is TBD vs. TBD **and already correctly** `state: unstarted` — needed so the
  correction-counting logic has a case it must *not* count, proving it isn't just flagging every TBD
  match. (`tests/riot-rest-parse.test.ts`, "leaves TBD + unstarted alone...")
- At least one match whose `startTime` is *after* the capture time, yet Riot still reports it
  `completed` — the case that rules out "state is only wrong for past matches" as a workaround.
  (`tests/riot-rest-parse.test.ts`, "corrects a match scheduled in the future...")
- At least one match between two real (non-TBD) teams, `state: completed`, where a side won without
  taking every game of the series (e.g. a Bo3 that ended 2-0) — proves `gamesPlayed` is derived from
  actual win counts, not copied from `seriesLength`.
  (`tests/riot-rest-parse.test.ts`, "derives gamesPlayed from per-team win counts...")
- Zero matches under `worlds` / `msi` / `first_stand` is FINE and does not need to be reproduced —
  the test asserting this constructs its "off-season" comparison from the real fixture's absence of
  international matches, but the underlying behaviour (a covered league can validly have zero
  matches in a window) doesn't require zero specifically; it needs the international leagues to not
  be *artificially* padded with matches that wouldn't naturally be there.
  (`tests/riot-rest-adapter.test.ts`, "does not require the international events to have any matches")
- At least one `lck` match within 7 days of the capture time, **and** at least one
  `lck_challengers_league` match in the same window on a *different* day than any `lck` match — this
  is what proves a prefix/substring league filter doesn't leak the wrong league in. This is also
  SPEC §8 Stage 0's literal acceptance criterion ("a CLI prints the next 7 days of a covered league"),
  so a replacement here has direct product-visible consequences, not just test consequences.
  (`tests/cli-select.test.ts`, "excludes lck_challengers_league...")
- After removing all `lck` rows, more than a token number of matches should remain, and restricting
  to only already-started matches should also leave more than a token number — both canary tests
  need *something* left to check against, not an exact count.
  (`tests/riot-rest-adapter.test.ts`, "fails when one covered league silently disappears" /
  "fails when the feed carries only stale rows")

**Not required from this fixture** (handled by synthetic data elsewhere, so don't go looking for it
here): a real cross-league case (an LCK team playing under `worlds`) is tested with
`matchEvent()`-built synthetic data in `tests/riot-team-identity.test.ts`, not against a real capture.

### What is a "lossy-state" case

Riot's `state` field is unreliable specifically for matches with an undecided side: across the
2026-08-09 capture, 3 of 7 TBD matches were marked `completed` and 4 `unstarted`, with no consistent
rule (two matches in the same tournament, a day apart, disagreed). `result` is the reliable signal
instead — every unplayed match has `result: null` on both sides, and no played match does. So the
parser trusts `result` over `state`, and a "lossy-state" case is any row where trusting `state`
alone would have gotten the answer wrong. See `src/sources/riot/rest/parse.ts` for the actual logic.

## `rest_getSchedule_2026-08-11.json`

The already-committed en-US reference capture (see its own `.meta.json`). No test reads it yet — it
exists to prove the locale fix works and as the first candidate to check against the list above. As
measured: **0** lossy-state candidates, **3** TBD-involving events (vs. rest_getSchedule.json's 9 and
7). It fails the second and third bullets above outright, which is exactly why it was not used to
replace `rest_getSchedule.json` — see `fixtures/README.md`'s Open section.

## `rest_getTeams.json`

- At least one archived team, at least one active team with a null `homeLeague`, and at least one
  active team whose home league is a real but uncovered second team (e.g. an academy roster under a
  league not in `config/leagues.json`'s covered set) — each is a case the team table must *exclude*.
  (`tests/riot-team-identity.test.ts`, "the team table" describe block)
- **Exactly one colliding code, and it has to be `EG`.** This is a genuine exception to "existence,
  not exact count" above: `config/leagues.json` carries a hand-written override keyed specifically to
  the `EG` collision (one org under `lcs`, another unrelated org under `lec`, sharing a code). A
  replacement capture would need that *same* real-world collision to still exist, or the override —
  and the test asserting it — would need to be re-derived against whatever collision (if any) the new
  capture actually has. This is the fixture most likely to block a clean swap.
  (`tests/riot-team-identity.test.ts`, "contains exactly one colliding code, and it is EG")
- At least a few rows homed at an international event (Worlds/MSI) that are NOT real playing teams
  (era-appropriate defunct orgs or region placeholders) — proves international events are excluded
  from defining team identity even though their matches are still resolved.
  (`tests/riot-team-identity.test.ts`, "does not let an international event define who the teams are")
- Enough rows across all five covered regional leagues (lck/lpl/lec/lcs/lcp) to resolve every
  non-TBD side that appears in the paired `rest_getSchedule.json`, including at least one
  parent-org/academy pair sharing a code but not a name (e.g. `kt Rolster` / `kt Challengers`).
  (`tests/riot-team-identity.test.ts`, "resolves every non-TBD team in a covered league" and
  "separates a parent from its academy by name")

The collision-count figures asserted in `tests/team-index-collisions.test.ts` (46 by code / 15 by
name over all active rows, 168/0/1 narrowed) are a separate concern from this list — those are
measured against `rest_getTeams_full.json`, not this trimmed file, and would need their own
re-derivation against a fresh full capture. Out of scope for a `rest_getSchedule.json`-focused
recapture day.

## `rest_getLeagues.json`

Lighter requirements — mostly needs to list all eight covered slugs
(`worlds/msi/first_stand/lck/lpl/lec/lcs/lcp`) plus `lck_challengers_league` (used to test that a
challengers league is excluded rather than matched by a sloppy prefix check), each with a `name` and
`slug`. No test currently pins an exact total league count.

## `rest_getSchedule_ewc.json`

- At least one match, all under `league.slug: ewc_lol`.
- At least 12 non-TBD sides across all matches, each with a non-empty `name` — the fixture is used to
  prove an out-of-coverage league still yields matches and team *names* even though it resolves no
  team *ids*. (`tests/riot-team-identity.test.ts`, "the Esports World Cup capture, now out of scope")

This fixture is not part of the locale problem (already `hl=en-US`, verified) and isn't a candidate
for this recapture round — listed here only for completeness, so a future "recapture everything" day
has one place to check all four files against.

## `rest_getSchedule_crawl_2026-08-12/`

Added Stage 0.7. Already `hl=en-US` and not part of the locale problem either — listed for the same
reason as the ewc fixture. **This one is not swapped in by hand**: re-derive it with
`npm run capture -- getSchedule <dir> --crawl`, never by copying pages from elsewhere, because a
`pageToken` from one crawl does not describe a page boundary in another (see `fixtures/README.md`'s
Crawl fixtures section). What a replacement crawl needs, all asserted in `tests/fixture-crawl.test.ts`:

- **At least 2 pages.** A 1-page crawl proves nothing pagination-specific — it's indistinguishable
  from `rest_getSchedule.json` with extra ceremony.
- **Every page but the last has a non-null `pages.newer`; the last has `null`.** This is the
  termination condition `fetchMatches`' crawl relies on — a replacement that never reaches `null`
  within `maxPages` (20) is not a valid replacement, it's a page-cap failure.
- **Page spans are contiguous and ascending**, and **no `match.id` appears on two pages.** Both are
  exhaustive-over-this-corpus claims in `docs/sources/lolesports-rest.md`'s Pagination section;
  a replacement that breaks either invalidates that prose, not just this fixture.
- **At least one `lck` match somewhere in the crawl** — keeps the corpus connected to a covered
  league rather than being pure plumbing. `lck` specifically only because it's what the rest of
  `riot-lol/`'s fixtures already use as their canonical "does resolution work" league; any covered
  regional league would satisfy the actual requirement.

**Not required**: a specific page count or a specific horizon. `crawl.meta.json`'s
`recapture.crawl.pagesCaptured` and `.horizonUtc` are measurements of one crawl, not a contract —
page count is a function of match density (verified: page 6 alone spans a month while page 1 spans
four days), so a replacement crawl taking 5 pages or 9, or reaching a different horizon, is not a
failure as long as the conditions above hold.
