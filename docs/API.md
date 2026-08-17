# JSON API

The one API. Web, ICS and the native iOS client all consume this and nothing else — NFR-1 says
every capability is available over JSON, and stage 7 is its exam: anything the Swift client needs
added is *a finding about this document*, not a task.

Stage 2b. Base path `/v1`. `npm run serve` (needs `DATABASE_URL`; `PORT` defaults to 3000).

---

## Authentication

A bearer token in a header. Not a cookie — a cookie is carried by the browser, and a native client
would have to emulate one.

```
Authorization: Bearer <token>
```

Get a token from `POST /v1/anon-users`. That response is the **only** one in the API that ever
contains a token; store it (`localStorage` on web, Keychain on iOS) and send it on every
`/v1/me/*` request.

The token is not the user id. The id grants nothing and appears in responses and logs freely; the
token grants everything and appears in exactly one response. See SPEC §2 FR-1 for the accepted
risk — it is a bearer credential with no recovery path, protecting which leagues a browser follows.

**Every authentication failure is identical**: no header, wrong scheme, malformed value and an
unknown token all return the same `401` body. That is deliberate. A caller must not be able to use
the error to learn whether a token exists.

## Error shape

Every error, everywhere:

```json
{ "error": { "code": "bad_request", "message": "anchor: Required" } }
```

`code` is one of `bad_request` (400), `unauthorized` (401), `not_found` (404), `internal` (500).
A 500's message is never the underlying exception — a `pg` error names tables and columns.

## Paging

`GET /v1/matches` and `GET /v1/me/calendar` share one contract.

| Parameter | | |
|---|---|---|
| `anchor` | **required** | ISO 8601 instant **with an explicit zone marker**. `2026-08-12T00:00:00Z` is valid; `2026-08-12T00:00:00` is a 400. |
| `direction` | `forward` (default) or `backward` | `forward` is the default view: matches at or after the anchor, **plus everything currently in progress**. `backward` is the user scrolling up into the past. |
| `limit` | 1–100, default 50 | |
| `cursor` | opaque string | Echo back `nextCursor` from the previous response. |
| `league` | repeatable | Canonical league ids. `?league=a&league=b` is a union. |
| `team` | repeatable | Canonical team ids. A match matches if either side is one. |

**`anchor` is required and the server never substitutes its own clock.** The client states its own
reference point. The same rule governs `src/cli/next-matches.ts --now` and every fixture-backed
test: an endpoint that silently reads wall-clock time answers a different question than the one
asked.

**Paging is keyset, not offset.** `nextCursor` names a position in the ordering, so a sync run
inserting matches while a user scrolls cannot make the next page skip or repeat one. `nextCursor`
is `null` when the page was not full.

**The past is what we already have.** Paging backwards serves matches already in the database; the
product never fetches history upstream (SPEC §2 FR-2). A freshly-seeded database has almost no
past, and that is correct behaviour rather than a bug.

---

## Endpoints

### Identity

#### `POST /v1/anon-users`

Creates an anonymous user. No body, no auth.

`201` → `{ "userId": "...", "token": "..." }`

### Overview — public, no token

#### `GET /v1/matches`

Paging parameters above.

```json
{
  "matches": [
    {
      "id": "...", "game": "lol", "leagueId": "...", "tournamentId": null,
      "startsAtUtc": "2026-08-12T08:00:00Z", "state": "unstarted",
      "seriesLength": 3, "gamesPlayed": 0,
      "sides": [
        { "team": { "id": "...", "game": "lol", "name": "T1", "code": "T1", "logoUrl": null }, "score": null },
        { "team": null, "score": null }
      ],
      "stageLabel": "Week 11", "streamUrl": null, "revision": 1
    }
  ],
  "nextCursor": "eyJzdGFydHNBdFV0YyI6..."
}
```

`"team": null` means TBD. It is not an error and the match is not withheld — a side resolving later
is normal, and the match joins a user's calendar by itself when it does (FR-1 rule 7).

**There is no `endsAtUtc` and there will not be one.** Riot supplies no end time. A client that
needs a block computes it from `seriesLength` — 60 min / 3 h / 5 h for Bo1 / Bo3 / Bo5 — and must
present it as an estimate. SPEC §1 explains why the estimate is not persisted.

**Scores are returned even for finished matches, and hiding them is your job.** See the client
contract below — this is the one place where a client that does nothing produces a product bug.

#### `GET /v1/leagues`

The covered leagues, for rendering the filter. `200` → `{ "leagues": [{ id, slug, name, region,
logoUrl, tier, kind }] }`. Excludes leagues explicitly marked `minor` in `config/leagues.json`;
includes `unclassified` ones, because those are leagues that appeared upstream after the file was
last reviewed and hiding them would make a coverage gap invisible.

### My calendar — token required

| | | |
|---|---|---|
| `GET` | `/v1/me` | `{ userId }`. Use it to check a stored token is still good. |
| `GET` | `/v1/me/follows` | `{ follows: [{ targetType, targetId }] }` |
| `POST` | `/v1/me/follows` | Body `{ targetType: "league" \| "team", targetId }`. `201` when created, `200` when it was already there — following twice is a no-op, not a conflict. |
| `DELETE` | `/v1/me/follows/:targetType/:targetId` | `204`. **Deletes no selection** — see below. |
| `GET` | `/v1/me/selections` | `{ selections: [{ matchId, state }] }` |
| `PUT` | `/v1/me/selections/:matchId` | Body `{ state: "included" \| "excluded" }`. Idempotent. |
| `DELETE` | `/v1/me/selections/:matchId` | `204`. Not the inverse of `PUT` — see below. |
| `GET` | `/v1/me/calendar` | Paging parameters above; same response shape as `/v1/matches`. |

#### The three rules a client will get wrong

**1. Filtering is not following.** `GET /v1/matches?league=...` is view state and writes nothing.
`POST /v1/me/follows` is stored data and changes the calendar. Putting the two controls next to
each other in a UI is fine; wiring them to each other is not (FR-2).

**2. Unfollowing does not delete picks.** `DELETE /v1/me/follows/team/x` removes the standing rule.
Matches the user picked by hand while following stay on the calendar — those were separate,
explicit statements (FR-1 rule 3).

**3. `PUT {"state":"excluded"}` and `DELETE` are different actions.**

- `PUT excluded` — "I do not want this match", and it *stays* said. It survives the match
  finishing and survives the follow being removed, so re-following the team later does not
  resurrect a match the user removed (FR-1 rules 4 and 5).
- `DELETE` — "treat it as if I had said nothing". The match returns to whatever the follows derive.

A client's "remove from calendar" button is `PUT excluded`. `DELETE` is an undo of the statement
itself, and most UIs never need it.

---

## Client contract: spoiler masking

**This API has no spoiler mode.** Every match response carries `sides[].score` and `gamesPlayed`
whatever their values, on the authenticated calendar and on the public `GET /v1/matches` alike.
Decided 2026-08-17. It is deliberate — a code review read it as a defect, which is exactly why it is
spelled out here.

The reason it is safe to ship the data: the *presence* of a score reveals nothing `state` does not
already reveal. Upstream, `result == null` determines state exactly (7 of 7 unplayed, 0 of 73 played,
measured over the 2026-08-09 capture and pinned by a test), so a score exists precisely when the
match has started. Only the **value** is a spoiler.

Which makes masking a client obligation rather than a server one. Every client MUST implement it:

```
const spoiler = match.state === 'completed' || match.state === 'inProgress';
// while `spoiler` and the user has not revealed:
//   hide  match.sides[].score
//   hide  match.gamesPlayed
```

**`gamesPlayed` is not optional to mask.** It leaks on its own: `gamesPlayed: 2` against
`seriesLength: 3` is a 2-0 sweep, so hiding only the score still tells the user the result was
one-sided.

Do **not** mask `state`, `seriesLength`, the teams, or `startsAtUtc`. None is a spoiler, and hiding
`state` would break the mask condition itself.

**ICS is different and it is absolute.** An ICS feed has no tap-to-reveal, and its `SUMMARY` lands on
a lock screen. `SUMMARY` never carries a score, a winner, or `gamesPlayed`, under any setting — there
is no reveal mechanism to gate it behind. CLAUDE.md carries this as non-negotiable.

What this design buys, and what it costs: revealing is instant with no second request, and the API
stays one shape for three clients. The cost is that the guarantee lives in those three clients rather
than in one shared layer — genuinely weaker than the player-data exclusion, which is enforced at the
adapter boundary by an undeclared zod field and therefore cannot be got wrong downstream.

---

## Known limitation: calendar pages are sparse

`GET /v1/me/calendar` pages over the **overview** and then composes. So `limit` bounds how many
matches are *examined*, not how many are returned.

Measured against the committed crawl fixture, 2026-08-17: a user following only `lck`, requesting
`limit=50`, receives **4 matches**. The other 46 slots were matches in leagues they do not follow.

This is the cost of keeping FR-1's rules in one pure function (`src/core/calendar.ts`) with
table-driven tests, rather than restating them as SQL. It is a real cost and it is not yet paid
down. The likely fix, when stage 3's UI makes it painful: narrow in SQL to
`derived ∪ explicitly-selected` first, then still run `composeCalendar` over that narrowed set as
the arbiter — the pure function stays the definition, the query stops reading rows it will discard.

Until then, a client paging the calendar should follow `nextCursor` until it is `null` rather than
assuming one request fills a screen.

## Not in this API yet

Source health and staleness (NFR-5 — `src/db/queries/health.ts` exists, no endpoint yet; stage 3
needs it). Spoiler mode. Stream resolution (FR-4). ICS export (stage 5). Notifications (stage 6).
Accounts and Google OAuth (stage 4). Rate limiting — `POST /v1/anon-users` is unthrottled and
creates a row per call, which belongs at the edge with stage 9's infrastructure.
