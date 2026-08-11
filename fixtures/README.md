# Fixtures

Real upstream responses, committed. Parsers are tested against these in CI, so an upstream
shape change turns the build red instead of silently emptying the calendar.

A fixture proves existence, never absence. `type: "show"` exists and has no `match` object — observed
in the VALORANT capture, inferred for LoL from the shared backend, never observed for LoL. Parsers
enumerate exhaustively and warn on unknown values.

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
appears, and assert in tests only what the committed file can hold. `rest_getTeams.json` is the case
that taught this: the counts in `docs/sources/lolesports-rest.md` were measured on a 1.5 MB response
that is not in version control, and the 71-row trim reproduces none of them. Use
`npm run capture -- <endpoint> <path>` so the full capture can be re-derived rather than trusted.

```
riot-lol/    gql_homeEvents.json, rest_getSchedule.json, rest_getSchedule_ewc.json,
             rest_getLeagues.json, rest_getTeams.json, rest_getEventDetails.json
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

## Sidecars

Every `<name>.json` has a `<name>.meta.json` recording the request that produced it: full URL,
every query and path parameter, non-secret headers, capture date, and — separately — which of
those were **verified** versus inferred after the fact.

A fixture without its parameters cannot be re-captured, cannot be diffed against live, and
silently disagrees with the client. `rest_getSchedule.json` was captured under `hl=zh-TW` while
the client pins `hl=en-US`; its sibling `rest_getLeagues.json` was captured under `en-US`. Nobody
noticed until the sidecars were written, and `region` is a translated field.

`npm run capture -- <endpoint> <outPathWithoutExtension>` writes both the response and its sidecar,
including the exact command needed to re-capture it. Prefer it over saving a response by hand — a
hand-saved fixture is how the `hl=zh-TW` discrepancy went unnoticed.

## Exception 2: personal data

**A field that SPEC explicitly excludes as personal data may be removed.** When it is, the sidecar
records `verbatim-except-<fields>` and the before/after row counts.

The verbatim rule exists to protect *test fidelity*. Removing a field the parser is required to
discard costs no fidelity — whereas real players' names committed to a public repo that states it
does not collect player data is a substantive problem, not a tidiness one. `rest_getTeams.json` is
the first case: every team in the master response carries a full roster under `players`.

This is not licence to trim inconvenient fields. It applies to personal data and nothing else.

## Open

- **Locale inconsistency in `riot-lol/`.** `rest_getSchedule.json` is `hl=zh-TW`;
  `rest_getLeagues.json` is `hl=en-US`; the client pins `en-US`. Only display fields differ today
  (`blockName`, `league.region`), so nothing is failing — but `region` is a UI grouping, and any
  future assertion on it will disagree with live. Re-capture both under `en-US` and repoint the
  tests' `--now` at the new capture date. Not urgent; it is a correctness trap, not a live bug.
  Note that the two Stage 0.5 fixtures (`rest_getTeams.json`, `rest_getSchedule_ewc.json`) are both
  `en-US` with verified sidecars, so the inconsistency no longer spans the whole directory.
- **`riot-lol/rest_getEventDetails.json` locale is unrecoverable.** The response contains no
  translated field, so which `hl` produced it cannot be determined. Re-capture if it ever matters.
- **`riot-lol/gql_homeEvents.json` cannot be re-captured at all** — the persisted-query hash and
  client version were not recorded. This was going to be Stage 0.5's problem; it is not, because
  `getTeams` supplied team identity over REST and the GraphQL adapter was dropped from the roadmap.
  The file stays as the only record of the composite team id form `{matchId}:{teamId}`, which is why
  `ExternalId` is documented as opaque and never parsed. `src/sources/riot/ids.ts` implemented the
  split and has since been deleted: GraphQL is off the roadmap, so nothing will ever emit a composite
  id, and the finding lives in `docs/sources/lolesports.md`.
- **`ewc_lol` left coverage on 2026-08-11**, so `rest_getSchedule_ewc.json` no longer exercises the
  cross-league resolution path it was captured for. It is kept deliberately: the test on it now asserts
  the opposite behaviour — an uncovered league still yields matches and team names, just no resolved
  ids — which is the assertion that decides whether narrowing coverage is safe.
