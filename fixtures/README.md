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
