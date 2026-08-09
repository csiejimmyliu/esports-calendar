# Fixtures

Real upstream responses, committed. Parsers are tested against these in CI, so an upstream
shape change turns the build red instead of silently emptying the calendar.

Trim to 3-5 matches per file, but **keep the edge cases** — TBD opponents, completed matches,
sweeps, and non-match events are the whole point.

A fixture proves existence, never absence. All 80 events in the first Riot sample were
`type: "match"`; `type: "show"` exists and has no `match` object. Parsers enumerate exhaustively
and warn on unknown values.

```
riot-lol/    gql_homeEvents.json, rest_getSchedule.json, rest_getLeagues.json, rest_eventDetails.json
riot-val/    getSchedule.json, getLeagues.json, getEventDetails.json
blast-cs/    schedule.json
```

## Sidecars

Every `<name>.json` has a `<name>.meta.json` recording the request that produced it: full URL,
every query and path parameter, non-secret headers, capture date, and — separately — which of
those were **verified** versus inferred after the fact.

A fixture without its parameters cannot be re-captured, cannot be diffed against live, and
silently disagrees with the client. `rest_getSchedule.json` was captured under `hl=zh-TW` while
the client pins `hl=en-US`; its sibling `rest_getLeagues.json` was captured under `en-US`. Nobody
noticed until the sidecars were written, and `region` is a translated field.

Keep the fixture itself a verbatim response. `blast-cs/schedule.json` has commentary merged into
it and is therefore not replayable — that is a defect to fix at Stage 7, not a pattern to copy.
