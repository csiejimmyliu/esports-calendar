# Fixtures

Real upstream responses, committed. Parsers are tested against these in CI, so an upstream
shape change turns the build red instead of silently emptying the calendar.

Trim to 3-5 matches per file, but **keep the edge cases** — TBD opponents, completed matches,
sweeps, and non-match events are the whole point.

A fixture proves existence, never absence. All 80 events in the first Riot sample were
`type: "match"`; `type: "show"` exists and has no `match` object. Parsers enumerate exhaustively
and warn on unknown values.

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

Keep the fixture itself a verbatim response. Trimming the top-level array is allowed and expected
— record the before and after counts in the sidecar — but nothing inside an element may be
edited, and no commentary may be merged in.

## The one exception to verbatim

A fixture must be stored verbatim. **The only exception is a field that SPEC explicitly excludes as
personal data.** When such a field is removed, the sidecar must record `verbatim-except-<fields>`
and the before/after row counts.

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
  The file stays as evidence for the composite-id split in `src/sources/riot/ids.ts`, which is the
  only thing it is still cited for.
