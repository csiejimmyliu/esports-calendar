# Source: VALORANT Esports

Probed 2026-08-09. Fixtures: `val_getSchedule_en.json` (80 events), `val_leagues_en.json`
(55 leagues), `val_eventDetails_en.json`.

## It is the same backend as LoL

Verified by probing four URL permutations:

| URL | Returns |
|---|---|
| `valorantesports.com/persisted/**val**/getSchedule` | VALORANT |
| `valorantesports.com/persisted/**gw**/getSchedule` | **LoL** |
| `lolesports.com/persisted/gw/getSchedule?sport=val` | **LoL** (`sport` ignored) |

**The title is selected by the path segment `/persisted/{gw|val}/`.** The domain is an alias; the
`sport` query parameter is ignored. The same `x-api-key` works for both. VALORANT league logos are
even served from `static.lolesports.com`.

Base: `https://esports-api.service.valorantesports.com/persisted/val/`
Endpoints: `getSchedule`, `getLeagues`, `getEventDetails` — all confirmed working with `hl=en-US`.

## Divergences from LoL — this is not a free copy

Same envelope, different field sets:

| Location | Present in VAL, absent in LoL |
|---|---|
| `event` | `tournament` |
| `event.league` | `image`, `region` |

`match` and `match.teams[]` field sets are identical.

### `tournament` is the same name with two incompatible shapes

```
getSchedule     → {"split": {"name": "Stage 2"}, "season": {"name": "valorant_champions_tour_2026"}}
getEventDetails → {"id": "116849341650384424"}
```

No overlap between them. Runtime validation must be per-endpoint, not per-field-name.

### Error responses use a different envelope

`getLive` on the `val` path returned:

```json
{"errors": [{"message": "Invalid request parameters"}]}
```

No `data` key. **Check for `errors` before reading `data`.** Otherwise the parser reads `undefined`
and reports zero rows — the silent-empty failure mode.

## `type: "show"` events have no `match`

2 of 80 VAL events were `type: "show"` (pre-game programming, analyst desk):

```json
{ "startTime": "...", "state": "inProgress", "type": "show",
  "league": {...}, "tournament": {...} }
```

**No `match`. No `blockName`.** Any parser doing `event.match.id` crashes.

All 80 events in the LoL sample were `type: "match"`, so an adapter written from that fixture alone
would pass its tests and then break in production — the two sources share a backend, so LoL emits
`show` events too. We simply did not sample one.

**Lesson: a fixture proves existence, never absence.** Parsers must enumerate `type` exhaustively
and log a warning on unknown values rather than throwing or silently dropping.

Calendar behaviour: filter to `type == "match"`. Shows are not matches.

## Newly resolved: `game.state == "unneeded"`

`val_eventDetails` captured a 2-0 Bo3:

```
game 1: completed
game 2: completed
game 3: unneeded
```

This answers the open question left by the LoL probe. Game states observed across both titles:
`unstarted`, `completed`, `unneeded`, and (by inference from event state) `inProgress`.

`event.state` confirmed to include `inProgress` in REST — observed twice in the VAL sample.

## Team identifiers

Plain numeric, same format as LoL REST, non-overlapping values:

```
LoL : 99566404850008779,  99566404848691211
VAL : 107185970379663407, 115938167218279093
```

Likely one id generator across titles, so collisions are improbable. **Still key `external_ref` by
(source, sport, external_id)** — one extra column buys out an unverifiable assumption.

Note the asymmetry: the GraphQL `homeEvents` endpoint returns *composite* team ids
(`{matchId}:{teamId}`); every REST endpoint returns plain ids.

## Leagues

55 leagues. Same `displayPriority` semantics as LoL — and the same uselessness as a tier signal:
`priority` is `1` for all 55, and `status` distributions mirror the LoL pattern
(`force_selected` for Champions / Masters / GC Championship, `hidden` for defunct regional
Challengers leagues).

Tier classification is ours to maintain, per `lolesports-rest.md`.

## Implication for Stage 7

VALORANT is a weak exam but not a worthless one. It forces the interface to handle: optional
`match`, optional `blockName`, a `tournament` field with per-endpoint shapes, optional
`league.image`/`region`, and a distinct error envelope.

It does **not** test a genuinely foreign source, since the backend is shared. **CS2 remains the
real exam** — different organizers, different stacks, and possibly no "league" tier at all.
