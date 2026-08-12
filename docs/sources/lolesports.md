# Source: LoL Esports GraphQL (lolesports.com) — DROPPED

Probed 2026-08-09. Verified against `fixtures/riot-lol/gql_homeEvents.json` (5 events).
Corrections applied where the automated probe report was wrong — see "Corrections" at the end.

> **This source is off the roadmap and was never implemented.** It was the intended primary for two
> reasons — team ids and a trustworthy `match.state` — and REST then supplied both: `getTeams` gives
> plain team ids in one unparameterised call, and `result == null` determines state exactly (7 of 7
> unplayed, 0 of 73 played, exhaustive over one capture, encoded as a test). See
> `lolesports-rest.md`.
>
> The note is kept for two things it is the only record of: the composite team id `{matchId}:{teamId}`,
> which is why `ExternalId` is documented as opaque and never parsed; and the "Corrections" section,
> which documents four specific ways an automated probe report was wrong.
>
> **`gql_homeEvents.json` can never be re-captured.** The persisted-query hash and client version it
> was fetched with were not recorded, so nothing in this note can be re-verified against live. Treat
> every claim below as frozen at 2026-08-09.

## Endpoint

- **URL**: `https://lolesports.com/api/gql?operationName=homeEvents&variables=<urlencoded JSON>&extensions=<urlencoded JSON with persisted query sha256Hash>`
- **Method**: GET
- **Required headers**:
  - `apollographql-client-name`
  - `apollographql-client-version` — a hardcoded frontend build id
  - `accept: application/graphql-response+json, application/json;q=0.9`
- **Auth**: none, but it is a **persisted query** — the query text is not sent, only a
  `sha256Hash` the server resolves server-side.
- **Pagination**: `esports.pages.{newer,older}` cursors exist but are null in the observed
  sample. The site paginates by moving the `eventDateStart`/`eventDateEnd` window instead.

One operation, three call shapes, differing only by variables:

| Purpose | `eventState` | Date window |
|---|---|---|
| Recent (done + upcoming) | `["completed","unstarted"]` | ~48h around now |
| Currently live | `["inProgress"]` | none |
| Future schedule | `["unstarted"]` | ~61 days |

### Fragility

The persisted-query hash plus the pinned client version are tied to a **frontend build**, not to a
credential. A frontend deploy can invalidate both. This is a higher-churn failure mode than a rotated
API key.

*Confidence: **architectural inference, never observed.** No hash invalidation was witnessed — the
probe worked on the day it ran and was never repeated. The reasoning is sound and it was cited as a
reason for the source ranking, so it is worth being clear that it is reasoning. It is also now
permanently untestable from this repo, since the hash and client version were not recorded.*

The older REST API (`esports-api.lolesports.com/persisted/gw/...`, static `x-api-key`) is alive and
churns less often.

> **Superseded.** This section originally concluded that REST "is nonetheless the secondary source, not
> the primary", because it exposes no team ids and its `state` field is wrong for unplayed playoff
> matches. Both objections were then answered — `getTeams` for the first, `result` for the second —
> and REST became the only source. "Use REST as failover and for cursor-based historical backfill" no
> longer describes anything: there is nothing to fail over from. The backfill point stands on its own
> merits (`getSchedule?leagueId=` returns full history with working cursors) and is tracked in
> `lolesports-rest.md`.

## Response shape

```
data.esports.events[]          -- EventMatch
  id                           -- string, numeric, stable. Same as match.id.
  type                         -- "match" (other values presumably exist)
  startTime                    -- ISO 8601 UTC, e.g. "2026-08-07T17:15:00Z"
  state                        -- UNRELIABLE, see below
  blockName                    -- free text, LOCALIZED ("第3週", "季後賽"). Not an entity.
  streams[]                    -- empty in every observed sample
  league  { id, name, slug, image, displayPriority { position, status } }
  tournament { id, name }      -- name is LOCALIZED ("2026夏季賽")
  matchTeams[]                 -- NOTE: on the event, NOT inside match
    id                         -- COMPOSITE "{matchId}:{teamId}"
    code, name, image, lightImage
    result { gameWins, outcome }  -- null entirely when TBD
  match
    id, type, state, flags[]
    strategy { type: "bestOf", count: N }
    games[] { id, number, state, vods[], recaps[] }
```

### Per-field notes

- **Match id** — numeric string, stable, usable as the source's external id directly.
- **Team id** — **composite**. Split on `:`; the segment *after* the colon is the stable team
  identity. Using the whole string as a team key creates a new "team" row per match.
- **Start time** — always concrete UTC. There is no "time TBD" representation; placeholder
  matches still carry a real timestamp.
- **Best-of** — `match.strategy.count`. `games[]` is pre-generated to that length before play.
- **State** — two fields, and they disagree. `event.state` was `"completed"` on matches whose
  `match.state` was `"unstarted"` (observed on CACG playoff placeholders). **Use `match.state`.**
  The meaning of the top-level field is not established; do not guess at it.
- **Streams** — `[]` in all five samples, across completed, unstarted, and TBD. Unresolved.
- **Logos** — served over **`http://`**, not https. Mixed-content blocked on an https site.
  Rewrite to https or proxy through our own CDN.
- **`lightImage`** — frequently null. Needs a fallback to `image`.

## Special cases

### TBD opponents
Both entries in `matchTeams[]` become:
```json
{ "code": "TBD", "name": "TBD", "id": "{matchId}:0",
  "image": ".../team-tbd.png", "result": null }
```
Two signals: team id suffix `0`, and `result` being `null` outright (a known team with no games
played has `{gameWins: 0, outcome: null}`, which is a different thing).

### Completed matches
**No new fields — only different values:**
- `match.flags`: `[]` → `["hasVod"]`
- `match.games[].state`: `"unstarted"` → `"completed"`
- `match.games[].vods[]`: `[]` → populated (multiple per game, one per language)
- `matchTeams[].result`: `{gameWins: 0, outcome: null}` → `{gameWins: N, outcome: "win"|"loss"}`

This is convenient: one parser handles both, no branching on shape.

### Localization
Response content varies by `hl`. `blockName` and `tournament.name` are translated; team names
were English even under `hl=zh-TW`.

**Identity must be resolved from a single fixed locale.** Display names are stored separately.

## Open questions — resolve before Stage 0 is done

1. ~~**Streams.**~~ **Decided, not pending.** Riot supplies no per-match streams and we do not
   wait for them. Resolution order for FR-4: the user's preferred `(provider, channel)` wins;
   when that channel is not broadcasting, fall back to the official link from a hand-maintained
   `League.defaultStreamUrl`. So `capabilities.streamUrls: false` is Riot's final state rather
   than a placeholder, and adapters do not warn per match about it. BLAST inverts this — it does
   supply per-match URLs, which is why stream availability is a declared capability at all.
2. ~~**Is the REST API alive?**~~ **Answered: yes, and it became the primary — then the only source.**
   `riot-rest-lol` is implemented, tested against golden fixtures, and GraphQL is dropped. This entry
   was left un-struck while the four around it were struck, which made the note look undecided about
   something the repo had already settled.
3. ~~`league.displayPriority.status` as a tier filter.~~ **Disproved.** It is per-request UI state,
   not a league property: CACG returned `hidden`/position 1000 here and `selected`/position 5 from
   REST `getLeagues` the same day, and LCK and LPL are `not_selected`. See `lolesports-rest.md`.
   Tier classification must be maintained by us.
4. ~~2-0 sweep in a Bo3 — what is game 3's state?~~ **Resolved: `"unneeded"`.** Confirmed from the
   VALORANT probe against the same backend. See `valorant.md`.
5. ~~Other `event.type` values.~~ **Resolved: `"show"` exists**, and such events carry **no `match` and
   no `blockName`**. Absence in a fixture is not evidence of absence upstream. Filter to
   `type == "match"`; enumerate `type` exhaustively and warn on unknown values.

   *Two corrections to how this was previously worded.* It said "all **80** events in this sample were
   `type: "match"`" — 80 is the **REST** capture's count; this note's sample is **5 events** (stated at
   the top). The denominator was borrowed from the wrong fixture. And `"show"` was observed in the
   **VALORANT** capture (2 of 80 events), not in any LoL capture; that it exists for LoL too is an
   inference from the shared backend, and a reasonable one, but no LoL `show` event has been seen. The
   mitigation is unaffected either way, which is why the cost of the inference is zero — but it was
   written in a declarative voice, which is the failure mode this repo's own rules are about.

## Corrections to the automated probe report

- Report placed `matchTeams` inside `match`. It is on the **event**.
- Report described team id as `"{matchId}:{teamId}"` but did not flag that the composite must be
  split before use — the single most consequential detail for identity resolution.
- Report did not note the `http://` logo URLs.
- Report did not note `league.displayPriority`.
