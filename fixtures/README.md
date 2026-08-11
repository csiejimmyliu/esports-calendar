# Fixtures

Real upstream responses, committed. Parsers are tested against these in CI, so an upstream shape
change turns the build red instead of silently emptying the calendar.

## What these files are, and are not, for

Every file here is a **frozen test input**, not a snapshot of current data. The two are easy to
conflate because they look identical (both are "a real API response"), but they answer different
questions and follow different rules.

**A test needs its input to stay fixed.** `npm run test` reads `rest_getSchedule.json`, feeds it to
the parser, and checks the output. Because the input never changes, a red test can only mean one
thing: the parser changed behaviour. If the fixture were refreshed automatically, a red test could
also mean "Riot returned something different today," and there would be no way to tell which from
the failure alone.

This has a sharper consequence than "don't edit fixtures casually": **an automatic refresh can make
a bug invisible without ever failing anything.** Suppose a match was captured with `result: null`
(unplayed) and the parser has a branch that only runs for that case. If the fixture is silently
replaced by a fresh capture after that match has been played, the branch stops being exercised —
tests stay green, coverage looks unchanged, and the one case that used to be tested no longer is.
Nothing signals this happened. So: **fixtures are never updated by a script running unattended.**
Every one of the `npm run capture*` commands below either writes to a new path or requires an
explicit `--write`, on purpose.

None of this means the files are set in stone forever. It means updating one is a **deliberate,
reviewed act** — see "The recapture ritual" below — not a side effect of anything scheduled.

## The recapture ritual

1. `RIOT_ESPORTS_API_KEY=... npm run capture:refresh -- <path, relative to fixtures/>`
   Fetches the live endpoint the fixture's sidecar records, applies the same trim/redact steps the
   sidecar records (`recapture.transform`), and writes the result to `<path>.new.json` — the
   committed fixture is untouched.
2. Read the printed shape diff (new/removed keys, a field that started being `null`, a new enum
   value, a collection that dropped to zero). This is a structural diff, not a byte diff — every
   match's time and score differ between any two captures, so comparing bytes would be 100% noise.
3. Open both files and check whether an edge case the old fixture existed to cover is still present
   in the new one (a TBD side, a completed match, a sweep, a non-match `type`). If it disappeared,
   either keep the old file alongside the new one as a second fixture, or add a synthetic case with
   `matchEvent()` / `scheduleEnvelope()` in `tests/fixtures.ts` to replace it.
4. Only then: re-run with `--write` to replace the committed fixture, update the sidecar's
   `capturedOn`, and — if the fixture is one `tests/fixtures.ts`'s `FIXTURE_CAPTURED_AT` clock is
   pinned to — move that date too, or every relative-date test silently returns nothing.

`npm run capture:check` runs step 1–2 across every capturable fixture in the tree in one pass and
prints a report; it never writes anything. It exists to answer "has Riot changed something we
depend on" without a human re-reading thirteen files by eye — the drift-detection half of this
doctrine. It is not wired into CI (it needs a live API key and network access); run it by hand when
you suspect something upstream moved, and expect it before widening league coverage.

`npm run capture -- <endpoint> <outPathWithoutExtension>` captures a **brand-new**, untrimmed
fixture and writes a matching sidecar — use this to add a fixture that doesn't exist yet, not to
refresh one that does.

All three read/write the `.meta.json` sidecar format below; `src/fixtures/sidecar.ts` validates it
and `tests/fixture-sidecars.test.ts` checks every committed sidecar against that schema.

## The rules, in one place

This file previously stated three different and incompatible trim rules — "trim to 3-5 matches per
file", "keep the fixture a verbatim response", and "trimming the top-level array is allowed and
expected". They are consolidated here, and `CLAUDE.md` carries the same two exceptions.

**A fixture is a verbatim response, with exactly two exceptions. Both are recorded in the sidecar.**

1. **The top-level collection may be trimmed for size.** Record the before and after counts in the
   sidecar. Nothing *inside* a retained element may be edited, and no commentary may be merged in.
   Keep the edge cases when you trim — TBD opponents, completed matches, sweeps, non-match events are
   the whole point of having a fixture at all.
2. **A field SPEC excludes as personal data may be removed.** The sidecar then says
   `verbatim-except-<fields>`. See below.

There is no target row count. "3-5 matches" was written before the fixtures existed and none of them
obeys it: `rest_getSchedule.json` keeps all 80 events because the state-correction and TBD cases are
spread across them, `rest_getTeams.json` is 71 of 1568, `rest_getSchedule_ewc.json` is 6 of 28. Trim
as little as the file size allows, not as much as the rule permits.

**A trimmed fixture cannot support a figure measured on the full response.** Say so where the figure
appears, and assert in tests only what the committed file can hold.

```
riot-lol/    gql_homeEvents.json, rest_getSchedule.json, rest_getSchedule_2026-08-11.json,
             rest_getSchedule_ewc.json, rest_getLeagues.json, rest_getTeams.json,
             rest_getTeams_full.json, rest_getEventDetails.json
riot-val/    getSchedule.json, getLeagues.json, getEventDetails.json
blast-cs/    bounty-2026-season-2_{matches,brackets}.json
             esports-world-cup-2026-cs2_{matches,brackets}.json
```

`rest_getSchedule_ewc.json` is suffixed because `leagueId` is a request parameter, the same reason
the BLAST files carry their slug. A second file called `rest_getSchedule.json` could not say which
league it was narrowed to. It exists because the unparameterised capture contains no team playing
under a league slug other than its own, so cross-league resolution had no evidence.

BLAST files are named `{tournamentSlug}_{endpoint}` because the slug is part of the request and a
file called `schedule.json` cannot say which tournament it came from.

`rest_getSchedule_2026-08-11.json` is suffixed differently — by **capture date**, not by a request
parameter. Its request is otherwise identical to `rest_getSchedule.json`'s (no parameters beyond
`hl`); the only thing that differs is when it was sent, because `getSchedule` has no time-window
parameter and returns whatever is near "now" at request time. See `fixtures/REQUIREMENTS.md` for why
this file exists alongside `rest_getSchedule.json` rather than replacing it.

### The two `getTeams` files, and why both exist

`rest_getTeams.json` (71 rows) and `rest_getTeams_full.json` (1568 rows) are the same endpoint,
trimmed to different jobs:

- **`rest_getTeams.json` is the parser's test input.** Small on purpose — fast to read, fast to
  diff, and every row in it exists because some test needs it there (see its sidecar's
  `trimming.selection`).
- **`rest_getTeams_full.json` is a measurement corpus.** The join-key decision documented in
  `src/sources/riot/rest/teams.ts` and `config/leagues.json` (name over code, because a code names
  the organisation and not the squad) rests on collision counts over the *whole* table — counts a
  71-row sample cannot produce. Before this file existed, those counts could only be measured
  against an ungitignored 1.5 MB file that lived on one machine, and one of them was silently wrong
  for two days as a direct result (27 vs. the real 46 — see `docs/sources/lolesports-rest.md`).
  `tests/team-index-collisions.test.ts` now asserts every one of those figures directly against
  this committed file, so the next person to touch the join key gets a red test instead of a stale
  comment if it changes.

`rest_getTeams_full.json` still has `players` removed (see Exception 2 below) — keeping every row
does not require keeping the one field that carries real names. `tests/fixture-transform.test.ts`
proves the 71-row file is exactly what you get by applying the recorded transform to the full one,
so the "two files, one relationship" claim is checked, not just asserted in prose.

## Sidecars

Every `<name>.json` has a `<name>.meta.json`. Every sidecar has a common core —
`fixture/source/request/capturedOn/contents` — plus free-form fields that differ fixture to fixture
for good reason (`verification`, `trimming`, `whyThisFixtureExists`, `knownDiscrepancy`, …), plus
one field that is the same shape everywhere and machine-validated: `recapture`.

```jsonc
"recapture": {
  "capturable": true,
  "endpoint": "getTeams",
  "params": { "hl": "en-US" },
  "transform": [
    { "op": "stripField", "path": "data.teams[].players", "why": "..." },
    { "op": "selectByKey", "path": "data.teams", "key": "id", "keep": [/* ids */], "why": "..." }
  ]
}
```

or, for a fixture that cannot be re-captured:

```jsonc
"recapture": { "capturable": false, "reason": "..." }
```

This exists because three different sessions each invented a different sidecar shape — the original
committed sidecars, an early draft of `scripts/capture-fixture.ts`, and a data-capture task briefed
independently of both — and none was ever checked against either of the others. `recapture` is the
part that has to be machine-readable to be useful at all: whether a fixture can be regenerated, and
if so, the exact request and the exact trim steps, as data the three `capture*` commands can execute
— not a paragraph describing what someone did once.

A fixture without a capturable `recapture` block, or without a `reason` on a non-capturable one,
fails `tests/fixture-sidecars.test.ts`.

A fixture without its request parameters at all cannot be re-captured, cannot be diffed against
live, and silently disagrees with the client. `rest_getSchedule.json` was captured under `hl=zh-TW`
while the client pins `hl=en-US`; its sibling `rest_getLeagues.json` was captured under `en-US`.
Nobody noticed until the sidecars were written, and `region` is a translated field. That
discrepancy is still open — see below — and `recapture.params` for `rest_getSchedule.json`
deliberately records `hl=zh-TW`, because the block must describe the request that actually produced
the committed file, not the one the client happens to pin.

## Exception 2: personal data

**A field that SPEC explicitly excludes as personal data may be removed.** When it is, the sidecar
records `verbatim-except-<fields>` and the before/after row counts.

The verbatim rule exists to protect *test fidelity*. Removing a field the parser is required to
discard costs no fidelity — whereas real players' names committed to a public repo that states it
does not collect player data is a substantive problem, not a tidiness one. `rest_getTeams.json` and
`rest_getTeams_full.json` are both this case: every team in the master response carries a full
roster under `players`.

This is not licence to trim inconvenient fields. It applies to personal data and nothing else.

## Evidence, not pending work

Four files here have no parser reading them and never will, under the current scope. Left
unlabelled, they read like unfinished tasks. They are not:

- **`riot-val/*` and `blast-cs/*`.** VALORANT and CS2 are off the roadmap (SPEC §0, decided
  2026-08-09) until the LoL calendar is complete. These are the captures that shaped
  `SourceCapabilities`, the `game` field, and the two-phase `listScopes` → `fetchMatches` interface
  before any of it was written — the evidence the abstraction met foreign requirements, kept
  because re-deriving it later would cost a full probing session again.
- **`riot-lol/gql_homeEvents.json`.** GraphQL was the originally intended primary source and was
  dropped once `getTeams` supplied team identity over REST instead (see
  `docs/sources/lolesports-rest.md`). This fixture cannot even be re-captured — the persisted-query
  hash and client version were never recorded — and is kept only as the sole surviving record of
  the composite team-id form `{matchId}:{teamId}`, which is why `ExternalId` is documented as
  opaque and never parsed.
- **`riot-lol/rest_getEventDetails.json`.** Used once, to cross-check that `getTeams` ids agree with
  another endpoint's (see `rest_getTeams.meta.json`'s `verification.identityOfIds`). No adapter code
  reads it.

## Open

- **Locale inconsistency in `riot-lol/`, and it turns out a plain re-capture cannot close it.**
  `rest_getSchedule.json` is `hl=zh-TW`; `rest_getLeagues.json` is `hl=en-US`; the client pins
  `en-US`. Only display fields differ today (`blockName`, `league.region`), so nothing is failing —
  but `region` is a UI grouping, and any future assertion on it will disagree with live.

  A locale-correct reference capture now exists —
  **`riot-lol/rest_getSchedule_2026-08-11.json`** — and confirms the fix works (`blockName` reads
  "Week 3" in English). It does **not** replace `rest_getSchedule.json`, and the reason is not a
  loose end, it's structural: `getSchedule` with no parameters returns whatever is near "now" at
  request time, not a fixed slice of history. Two days after the original 2026-08-09 capture, several
  edge cases several tests depend on — most notably 9 "lossy-state" corrections (see
  `fixtures/REQUIREMENTS.md`) that exist nowhere in the 2026-08-11 capture — because those specific
  matches had simply rolled out of the window. **There is no request you can make today that gets
  the 2026-08-09 matches back in English**, so this is not a "not urgent yet" item the way it used to
  read; it is only closable by a coordinated re-capture of every `riot-lol/` fixture on the same day,
  followed by rewriting the tests that currently assert exact counts and hardcoded ids against the
  old capture to assert structural conditions instead. `fixtures/REQUIREMENTS.md` is the checklist
  for exactly that day — what each fixture needs to contain, and which tests each condition backs.
- **`riot-lol/rest_getEventDetails.json` locale is unrecoverable.** The response contains no
  translated field, so which `hl` produced it cannot be determined from its content alone. Its
  sidecar records `en-US` as the client-pinned default, not as verified.
- **`riot-lol/gql_homeEvents.json` cannot be re-captured at all** — see "Evidence, not pending work"
  above.
- **`ewc_lol` left coverage on 2026-08-11**, so `rest_getSchedule_ewc.json` no longer exercises the
  cross-league resolution path it was captured for. It is kept deliberately: the test on it now asserts
  the opposite behaviour — an uncovered league still yields matches and team names, just no resolved
  ids — which is the assertion that decides whether narrowing coverage is safe.
- **The cursor parameter name for `getSchedule` pagination has never been probed.** See the
  `timeWindow` comment in `src/sources/riot/rest/adapter.ts` and the Pagination line in
  `docs/sources/lolesports-rest.md`. Needed before historical backfill is implemented, or before
  claiming `timeWindow: true`.
