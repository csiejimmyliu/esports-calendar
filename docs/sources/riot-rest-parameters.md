# Riot REST — parameter reference and probe log

Stage 0.8. This is the **reference**; `docs/sources/lolesports-rest.md` stays the **interpretive
note** — read that one first for why any of this matters to the adapter. Nothing here is copied
from there and nothing there is copied from here; where a probe below falsifies a claim in that
file, the note gets an in-place `> **Correction, 2026-08-12.**` block, per the house convention of
keeping the wrong claim visible rather than silently editing it away.

**Every number below names the probe id that produced it**, and every probe log is committed at
`docs/probes/riot-rest/<group>.probe.json`. Re-running `npm run probe -- <group>` overwrites that
file with fresh numbers from a fresh request — a claim here is re-derivable by one command, not an
assertion about this session (CLAUDE.md, "How source notes are written").

The runner (`scripts/probe-api.ts`) deliberately does not go through `RiotRestClient`: the client
converts a 4xx and an HTTP-200 error envelope into a thrown error and discards the body, which is
exactly what the `errors` group needed to keep. It reuses `RiotRestClient`'s conduct budget
(sequential, ≥1s apart, ≤20 requests per process) via `scripts/capture-lib.ts`.

## Parameters, per endpoint

### `getSchedule`

| Param | Required? | Observed domain | Omitted / wrong |
|---|---|---|---|
| `hl` | No (client pins it; endpoint has a default) | `en-US` used throughout. `zh-TW` accepted and translates `blockName` (`"Week 3"` → `"第3週"`) but **not** `league.slug` (probe `hl-zh-tw`). A malformed locale (`xx-XX`) is rejected outright: **HTTP 400** (probe `hl-invalid`) — no silent fallback to English. |
| `pageToken` | No | Base64, decodes to `newer::<snowflake>` / `older::<snowflake>` (established Stage 0.7). A **malformed** (non-base64) token is silently ignored — the response is byte-identical to the unparameterised anchor (49006 bytes both) — the API falls back to the default first page rather than erroring (probe `malformed-page-token`). A **well-formed but meaningless** token (`older::0`, base64) is accepted: HTTP 200, 0 events, no bounds check on the snowflake value (probe `meaningless-token`). |
| `leagueId` | No | Single value scopes to one league (`league-id-lck`: 80 events, `leagues=lck`). **The multi-value encoding matters and the two forms are NOT equivalent.** A comma-joined value (`leagueId=<lck>,<ewc>`) returns the union of both leagues (probe `multi-league-id-csv`). The repeated-key array form implied by community documentation (`?leagueId=<lck>&leagueId=<ewc>`) returns only the **last** occurrence — `ewc_lol` only, `lck` dropped (probe `schedule-leagueid-array-syntax`). Neither form is documented anywhere else, implied by any code, or used by `src/`; both are exploratory. |
| any unrecognised name | — | **Silently ignored.** `thisParamDoesNotExist=1` returned a byte-identical body to the anchor (probe `unknown-param`). Consequence: no "endpoint X has no parameter Y" claim in this repo, including several above, can be falsified by adding a nonsense param and seeing an error — only a byte-for-byte diff against a same-run anchor is meaningful, which is what every probe in this file that makes a "no effect" claim actually did. |

`leagueId` + `pageToken` together: **untested this run** (probe `league-id-and-page-token`). LCK's
own scoped call returned `pages.newer: null` this run (no forward page to chain from), so the probe
was skipped rather than sent with a placeholder token — see "Skipped probes" below. Stage 0.7 already
established the same composition question for the *global* forward crawl by construction (every page
after the first sends a real `pageToken`); what's untested is `leagueId` and `pageToken` **in the same
request**.

### `getLeagues`

| Param | Required? | Observed domain | Omitted / wrong |
|---|---|---|---|
| `hl` | No | Same locale pin as `getSchedule`. |
| `id` | No | **Narrows to exactly the requested league.** `id=<lck>` returned a 232-byte, 1-league response against a 10790-byte, 45-league anchor (probe `leagues-id-filter`). Not previously known to be supported. |

### `getTeams`

| Param | Required? | Observed domain | Omitted / wrong |
|---|---|---|---|
| `hl` | No | Same locale pin. **Confirmed the identity join's locale-stability premise same-instant**: `name` is byte-identical under `hl=zh-TW` vs the same-run `hl=en-US` anchor for **all 1568 compared teams**, zero mismatches (probe `teams-hl-zh-tw`). This supersedes the previous evidence, which was two fixtures captured **three days apart** under different `hl` values — see the correction below. |
| `id` | No | **Narrows to exactly the requested team.** `id=<EG LCS teamId>` (numeric external id) returned a 477-byte, 1-team response against a 1540971-byte, 1568-team anchor (probe `teams-id-filter`). **A team slug also works** — `id=t1` returned exactly T1 (probe `teams-id-slug`), confirming community documentation this project's own probing had no reason to think to test. Both forms narrow; which form the API prefers when both could match the same row is untested. |

> **`docs/sources/lolesports-rest.md:266` is wrong, and is corrected there.** It states `getTeams`
> "takes no other parameters; returns everything" — an assumption in the declarative voice that was
> never probed, the exact failure mode the file's own preamble apologises for twice. `id` both
> exists and narrows.

No pagination on `getTeams` — `data.pages` is absent entirely from the response (probe
`teams-anchor`, `hasPagesBlock: false`), consistent with the whole table returning in one call.

### Auth and transport-level

| Condition | Observed |
|---|---|
| Wrong `x-api-key` | **HTTP 403**, no JSON body at all (23 bytes, not the `{"errors": [...]}` envelope) (probe `wrong-key`). |
| `x-api-key` header omitted entirely | Also **HTTP 403**, identical 23-byte body — indistinguishable from a wrong key at the HTTP layer (probe `no-key-header`). `client.ts`'s "4xx is final, never retried" policy (`client.ts:85`) is therefore correct for a key problem: retrying would not help either case. |
| Nonexistent endpoint name | **HTTP 400** with the `{"errors": [{"message": "Invalid request parameters"}]}` envelope `client.ts` already checks for (probe `nonexistent-endpoint`) — the *same* shape as a bad parameter, not a 404. A caller cannot distinguish "endpoint typo" from "bad param" from the response alone. |

### `getEventDetails`

| Param | Required? | Observed domain |
|---|---|---|
| `hl` | No | Same locale pin. |
| `id` | Yes | Single snowflake only. A **comma-joined pair is rejected outright** — HTTP 400, not partial or first-only (probe `event-details-two-ids`; the earlier suspicion of "only the first id honoured" is wrong — it errors instead). An **unknown-but-well-formed** id (`999999999999999999`) returns **HTTP 200 with `{"data": {"event": null}}`** (probe `event-details-bogus`) — **not** the `{"errors": [...]}` shape `RiotErrorEnvelope` checks for. A caller must check for a null `event` explicitly; the existing error-envelope check would not catch this. |

### `getTournamentsForLeague`, `getStandings`, `getCompletedEvents`, `getLive`, `getGames`

Named in `lolesports-rest.md:57-58` (all but `getGames`), never called by any code path. Four were
never probed before this stage; `getGames` was never even named in this project until a
cross-reference against community documentation found it — see "The doc-cross-check group" below.

| Endpoint | Params tried | Result |
|---|---|---|
| `getTournamentsForLeague` | `leagueId` | HTTP 200. Returns a nested `data.leagues[].tournaments[]` structure; one LCK league carried a tournament id used by the next probe (probe `tournaments-for-league`). |
| `getStandings` | `tournamentId` | HTTP 200, 26595 bytes. Response nests `data.standings[].stages[].sections[].matches[]`, and each match's teams carry both `id` **and** `slug` (e.g. `T1`, `"t1"`) — richer than `getSchedule`'s teams, which have no id at all (probe `standings`). Not investigated further; noted for a future stage that needs standings. |
| `getCompletedEvents` | `leagueId` first (probe `completed-events`, wrong — see correction below), then `tournamentId` (probe `completed-events-tournamentid`, correct) | **`leagueId` is silently ignored — the documented parameter is `tournamentId`.** `leagueId=<lck>` produced a response byte-for-byte identical in event count to a no-params anchor (probe `completed-events-no-params` vs `completed-events-leagueid`, both 300 events): the earlier "300 real LCK events" claim from this stage's own first pass described the endpoint's global default scope, not an LCK-filtered result. `tournamentId=<lck tournament id>` genuinely scopes it — 20 events, differing from the anchor (probe `completed-events-tournamentid`). Shape differs from `getSchedule`: `league` here is `{name}` only, **no `slug`**; `match.type` is `"normal"` (a field `getSchedule`'s `ScheduleMatch` schema doesn't have); games carry a `vods[]` array (out of scope per CLAUDE.md, noted only because it's there). This endpoint is the one with direct bearing on the still-open "past matches" product question — see the open items list in the Stage 0.8 plan — but any future use of it must scope by `tournamentId`, not `leagueId`. |
| `getLive` | `hl` | HTTP 200, `{"events": []}` — same inconclusive result as the earlier probe in `lolesports-rest.md:461` (probe `live`). Still not during a confirmed broadcast. n=2 now, both empty, both off-hours. |
| `getGames` | `id` (a game id, not a match id) | HTTP 200. Returns `data.games[]`, each `{id, state, number, vods[]}` — a lighter, more focused endpoint than `getEventDetails`, keyed one level below a match (probe `games-by-id`). Not investigated further; noted for whenever VOD or per-game state data is wanted, which is currently out of scope per CLAUDE.md. |

## Boundary findings that change how a claim in `lolesports-rest.md` should be read

1. **`getTeams`'s "no other parameters" claim is retired**, not merely unverified — `id` exists and
   works. *Basis: measured, this run, n=1, probe `teams-id-filter`.*
2. **The name-join locale-stability premise now has same-instant, exhaustive evidence**, not just
   two fixtures three days apart. *Basis: measured, this run, n=1568 (all teams present in both the
   `hl=en-US` and `hl=zh-TW` responses), probe `teams-hl-zh-tw`. Zero mismatches.* This is the
   single most consequential result in this stage — a mismatch would have been a Stage 1 blocker for
   the whole team-identity design, not a documentation nicety, and the stage's plan said to stop and
   report if it happened. It didn't.
3. **Unknown query parameters are silently ignored**, not rejected. Every "endpoint X has no
   parameter Y" statement in this repo — including several in this file — is bounded by that: a typo
   in a real parameter name is indistinguishable from that parameter never existing, from the
   response alone. *Basis: measured, this run, n=1, probe `unknown-param`.*
4. **`getSchedule`'s error handling for a malformed cursor is silent fallback, not rejection** — a
   corrupted `pageToken` does not surface as an error anywhere in the response; it just serves page
   one again. A sync layer that resumes a saved cursor without validating it first cannot tell
   "resumed correctly" from "silently restarted". *Basis: measured, this run, n=1, probe
   `malformed-page-token`.*
5. **`getEventDetails`'s "not found" shape is a null field inside a 200, not an error envelope.**
   `client.ts`'s current error detection (`RiotErrorEnvelope.safeParse` before reading `data`) would
   pass this straight through as success. Nothing in `src/` calls `getEventDetails` today, so this is
   not a live bug — it's a finding for whenever it is wired up. *Basis: measured, this run, n=1,
   probe `event-details-bogus`.*
6. **`getCompletedEvents` is a real, working endpoint**, not a documented-but-absent capability —
   but it is scoped by `tournamentId`, **not** `leagueId`. The first pass of this stage got this
   wrong: `leagueId` is silently ignored (finding 3 already established that unrecognised params
   are ignored; this endpoint's own parameter name turned out to be one this project guessed
   incorrectly), so the "300 real LCK events" originally reported was the endpoint's global default
   scope, not a league-filtered result. Whatever the owner decides about "past matches are no
   longer important" vs SPEC §1's "in scope", the data behind that decision is one
   `tournamentId`-scoped call away, not an unknown — but a future implementation must use the right
   parameter. *Basis: measured, this run, n=1 each, probes `completed-events-no-params`,
   `completed-events-leagueid`, `completed-events-tournamentid`.*
7. **`getSchedule`'s two multi-value `leagueId` encodings are not equivalent.** Comma-joined
   (`A,B`) returns the union; repeated keys (`A&leagueId=B`) return only the last occurrence.
   Neither is documented or used by `src/`, but a future implementation reaching for the "obvious"
   array syntax (repeated keys) would silently drop every league but the last one named. *Basis:
   measured, this run, n=1, probe `schedule-leagueid-array-syntax`.*
8. **A `getGames` endpoint exists and this project never knew it.** Found only by cross-referencing
   community documentation after the first five probe groups were already run and written up —
   the clearest evidence that black-box probing alone does not find every boundary; enumerating
   *known* endpoints and testing *their* parameters cannot surface an endpoint nobody thought to
   name in the first place. *Basis: measured, this run, n=1, probe `games-by-id`; existence
   cross-referenced against `vickz84259.github.io/lolesports-api-docs` and
   `kingjakeu/lolesports`'s unofficial guide.*

## Probe log

Six groups, 33 probes attempted, 32 sent (1 skipped — see below), all live against
`https://esports-api.lolesports.com/persisted/gw/`, captured 2026-08-12. Full machine-readable logs:
`docs/probes/riot-rest/{schedule-params,catalog-params,errors,unmapped-endpoints,event-details,doc-cross-check}.probe.json`.
The first five groups were pure black-box probing; `doc-cross-check` is a sixth, added after
cross-referencing community documentation surfaced gaps in the first five — see its own section
below for why that step matters on its own.

### `schedule-params` (7 probes, 1 skipped)

- **`anchor`** — why: every other probe in this group compares against it rather than against a
  hardcoded expectation, so a same-day upstream change doesn't invalidate the comparison, only the
  absolute numbers. Expected: some baseline shape. Got: 80 events, 23 distinct league slugs, both
  cursors non-null. Nothing changed as a result — this is the control, not a finding.
- **`unknown-param`** — why: bounds every "no such parameter" claim anywhere else in this repo.
  Expected either outcome plausible going in. Got: silently ignored (byte-identical body). Changed:
  added finding 3 above, and reworded every parameter-absence claim in the table to say what was
  actually tested (byte-diff against a same-run anchor), not "no error was returned".
- **`hl-zh-tw`** — why: cheap same-run locale check before the higher-stakes `getTeams` version.
  Expected `blockName` to translate (already known from Stage 0.7-era fixtures). Got exactly that,
  plus confirmation `league.slug` does not translate. Nothing new; corroborates existing doctrine
  that `slug` is the safe key and `blockName`/`name` are not.
- **`hl-invalid`** — why: a silent fallback to English would make a typo'd locale invisible in a
  sidecar, which is the exact bug class `rest_getSchedule.json`'s `hl=zh-TW`-vs-pinned-`en-US`
  mismatch belongs to. Expected either outcome. Got: HTTP 400, hard rejection. Changed: this closes
  a real risk — a future fixture capture with a typo'd `hl` fails loudly rather than silently
  drifting.
- **`league-id-lck`** — why: anchor for the next two probes and a direct re-check of the Stage 0.7
  finding that `leagueId` paginates. Got: 80 events, single league, consistent with Stage 0.7.
- **`league-id-and-page-token`** — why: does `leagueId` survive being combined with `pageToken`, or
  does one silently win? **Skipped, not sent**: `league-id-lck`'s `pages.newer` was `null` this run
  (LCK had no more-recent page to chain to at the moment of the probe), so there was no real token to
  combine it with, and the runner sends real values only — see "Skipped probes" below. Still open.
- **`multi-league-id-csv`** — why: purely exploratory, nothing in the codebase implies this works.
  Expected: probably ignored, one id honoured. Got: **both** leagues' events returned. Changed:
  finding, recorded as exploratory only — not used, not implemented, not implied to be stable.

### `catalog-params` (5 probes)

- **`leagues-anchor`** / **`leagues-id-filter`** — why: is `getLeagues` filterable the way
  `getSchedule` turned out to be. Got: yes, `id` narrows cleanly (232 bytes / 1 row vs 10790 bytes /
  45 rows). Changed: `getLeagues` gains a documented parameter it didn't have one before.
- **`teams-anchor`** — why: establish the byte/row baseline `teams-id-filter` and `teams-hl-zh-tw`
  compare against, and check for a `pages` block (there could plausibly have been silent
  pagination this whole time). Got: 1568 teams, no `pages` key at all. Nothing changed — corroborates
  the existing "one call returns everything" belief, just for a different reason (no pagination
  exists, rather than "no parameter narrows it").
- **`teams-id-filter`** — why: the single highest-value cheap probe to run before the expensive
  locale one, and the one that directly tests `lolesports-rest.md:266`'s literal claim. Expected:
  either confirms or retires the claim; going in, no prior. Got: narrows cleanly. **Changed:**
  `lolesports-rest.md:266` is now known false and is corrected in place.
- **`teams-hl-zh-tw`** — why: the highest-value probe in the entire stage. The whole team-identity
  design (CLAUDE.md, "Team identity is a narrowed join") rests on names being locale-stable, and the
  existing evidence for that was two fixtures captured three days apart under different `hl`. This
  probe tests the same claim same-instant, at full scale (1568 teams, not a sample). The Stage 0.8
  plan said explicitly: stop and report if this shows locale-dependent names, because that would be a
  Stage 1 blocker. Expected: probably identical, but this was a real "could go either way" probe, not
  a formality. Got: **zero mismatches across all 1568 compared teams.** Changed: upgrades the
  locale-stability premise from "two fixtures, three days apart, different hl" to "same-instant,
  exhaustive over the full table". Nothing needed correcting in the note; the confidence label there
  can be strengthened, and is, in the cross-link edit to `lolesports-rest.md`.

### `errors` (5 probes)

- **`wrong-key`** / **`no-key-header`** — why: pin `client.ts`'s "4xx never retries" policy to
  observed behaviour for the specific case that policy exists to handle (a rotated key). Got: both
  HTTP 403, identical short body, no JSON envelope. Changed: confirms the policy is correctly scoped
  — retrying either case would waste the client's 3-attempt budget for no gain.
- **`nonexistent-endpoint`** — why: is a typo'd endpoint name a 404, or does it fall into the same
  bad-parameter bucket as everything else. Got: HTTP 400, the same `{"errors": [...]}` envelope as
  a malformed parameter elsewhere. Changed: a caller (or a capture script typo) cannot distinguish
  "wrong endpoint" from "wrong parameter" from the response shape alone — worth knowing if
  `capture-fixture.ts`'s lack of an endpoint allowlist (it accepts any string, see the earlier
  exploration in this stage) is ever revisited.
- **`malformed-page-token`** — why: pins the retry/final-error boundary for a corrupted cursor, the
  case most likely to occur from a bug in a resumable crawl. Iterated mid-stage: the first pass's
  analyzer only checked for an error envelope and reported "no error" without checking whether the
  response actually differed from the anchor. Rewrote it to compare event count and span against the
  anchor before concluding, then re-ran. Got: **byte-identical to the anchor** — a malformed token is
  silently ignored and the endpoint serves the default first page. Changed: finding 4 above; a
  meaningful risk for any future resumable-crawl design, since "the crawl resumed" and "the crawl
  silently restarted from page one" produce indistinguishable responses.
- **`meaningless-token`** — why: does the endpoint validate the *value* inside a well-formed token,
  or only its shape. Got: accepted, 0 events, no error. Changed: confirms there's no bounds check on
  the snowflake value — a very old or very future cursor is treated as "nothing here" rather than
  "invalid", which is the behaviourally safer failure mode for a crawl.

### `unmapped-endpoints` (4 probes)

- **`tournaments-for-league`** — why: named, never called, and a prerequisite for `standings`.
  Got: works, real data, supplied a tournament id.
- **`standings`** — why: complete the never-probed set. Got: works; noted its teams carry an `id`
  and a `slug` that `getSchedule`'s teams don't have — filed as a fact for a future stage, not
  investigated further here (no code changes in this stage).
- **`completed-events`** — why: the one with product consequences, see finding 6. Got: 300 rows,
  one call. Changed at the time: converted "past matches, unresolved API question" into "past
  matches, resolved API capability, unresolved product decision". **Later corrected in the
  `doc-cross-check` group**: the `leagueId` param this probe used turns out to be silently ignored
  — the 300 rows were not actually LCK-scoped. See finding 6's rewrite and `doc-cross-check` below.
  Left in this log entry rather than deleted, per the house convention of keeping the wrong claim
  visible with its correction attached, not silently edited away.
- **`live`** — why: one more data point on a previously-inconclusive result. Got: still `{"events":
  []}`, still off-hours. Nothing changed; the existing "re-probe during a broadcast" advice stands
  unmodified.

### `event-details` (6 probes)

- **`schedule-anchor`** — why: supplies real match ids and the `pages.older` token the walk below
  needs; not otherwise interesting.
- **`event-details-by-id`** — why: does `getEventDetails` carry stream data — the file's one
  remaining genuinely open question about streams. Got: a `streams` key exists and is `[]` for this
  (completed) match. Changed: this is the **second** data point on `streams` being present-but-empty
  — the existing note has one (an unstarted match, `n=1`); now `n=2`, one completed, one unstarted,
  both empty. Still not proof of absence, but two independent zeros instead of one.
- **`event-details-two-ids`** — why: does the endpoint batch. Iterated mid-stage: the first pass's
  analyzer assumed a 200 response and only checked which match id came back, so a 400 status printed
  a confusing "needs review" instead of the actual finding. Rewrote to check status first. Got: HTTP
  400 — a comma-joined id list is rejected outright. Changed: corrects an implicit assumption ("only
  the first id would be honoured") that was never actually tested before this probe; it errors
  instead.
- **`event-details-bogus`** — why: error shape for an id that cannot exist. Iterated mid-stage: same
  issue as above, the first analyzer only reported the (empty) error envelope and missed that the
  interesting fact was `data.event: null` inside a 200. Got: finding 5 above.
- **`older-walk-2`**, **`older-walk-3`** — why: the owner's explicit scope for this stage — confirm
  the `older` direction works and pages are contiguous, 3 pages deep, *not* find where it terminates.
  Got: both pages contiguous with their predecessor, both still return a non-null `pages.older` at
  page 3. Changed: nothing — this matches and reconfirms the existing `fixtures/README.md` Open item
  (6-page probe from a different session reached 480 events / `2026-07-19` without terminating); 3
  pages was enough to confirm the direction works, not to move that number.

### `doc-cross-check` (6 probes)

**Why this group exists.** The first five groups were pure black-box probing: pick a question,
send a request, read the response. Asked directly ("did you look this API's usage up online?") the
honest answer for the first five groups was no — every claim in this file up to this point came
from live requests and reading this repo's own existing docs, never from a third party. That is not
automatically a gap (this is an undocumented API; a probe is often stronger evidence than someone
else's blog post), but it is an *incomplete method* on its own: black-box probing can only test
questions someone thought to ask, and it cannot find an endpoint nobody named. Cross-referencing
`https://vickz84259.github.io/lolesports-api-docs/` and
`https://github.com/kingjakeu/lolesports/blob/main/doc/unofficial-riot-api-guide.md` (community
reverse-engineering, not official Riot docs — no source for this API is official) surfaced one
missing endpoint and one probable parameter mistake in this stage's own prior work. Both were then
tested live rather than taken on the community docs' word, since those are themselves unverified.

- **`games-by-id`** — why: `getGames` appears in both community docs and was never named anywhere
  in this project before this probe, not even in the "known but unmapped" list. Expected: might not
  exist, might be an alias for `getEventDetails`. Got: exists, HTTP 200, distinct and lighter shape
  (`{id, state, number, vods[]}` per game). Changed: finding 8 above; the endpoint table above gained
  a row.
- **`completed-events-no-params`** — why: establish the baseline `getCompletedEvents` returns with
  no scoping parameter at all, so the next two probes have something real to diff against (not a
  hardcoded expectation). Got: 300 events. Not a finding on its own — the anchor.
- **`completed-events-leagueid`** — why: re-check the earlier `unmapped-endpoints` group's own
  `leagueId`-scoped probe against this anchor, since finding 3 (unknown params are silently
  ignored) already gave reason to doubt it. Expected: could go either way, this is why it needed
  checking rather than assuming. Got: **byte-for-byte identical event count to the no-params
  anchor.** Changed: retracts the earlier "300 real LCK events" framing — see finding 6's rewrite.
- **`completed-events-tournamentid`** — why: the community-documented parameter, tested for real
  rather than trusted. Got: 20 events, genuinely different from the anchor. Changed: confirms
  `tournamentId` is the real scoping parameter, closing the question the previous two probes opened.
- **`schedule-leagueid-array-syntax`** — why: the earlier `multi-league-id-csv` probe (in
  `schedule-params`) used a comma-joined value; community docs describe `leagueId` as an "array",
  which in typical query-string convention means repeated keys, a different wire shape never
  tested. Expected: probably the same result as the comma-joined form. Got: **different** — only
  the last repeated key won, dropping the first league entirely. Changed: finding 7 above; a
  genuinely new fact neither this project's own probing nor a plain reading of the community docs
  would have produced alone — it took testing both encodings against each other.
- **`teams-id-slug`** — why: community docs describe `getTeams`' `id` param as a team slug; this
  project's own `teams-id-filter` probe (in `catalog-params`) had already confirmed a *numeric* id
  works, with no reason to also try a slug. Got: `id=t1` also narrows correctly. Changed: confirms
  the community docs' description as an additional, not competing, fact — both forms work.

### Skipped probes

One probe (`league-id-and-page-token`) was not sent: its prerequisite (`league-id-lck` returning a
non-null `pages.newer`) wasn't met this run. The runner treats this as a skip, not a probe with a
placeholder value — sending `pageToken=__SOME_SENTINEL__` would have produced a response to a
question nobody meant to ask and wasted one of the conduct budget's requests. This is a deliberate
design choice in `scripts/probe-api.ts`, not an oversight: see the doc comment on `ProbeDef.request`.
Re-running `schedule-params` at a time when LCK has a forward page pending would answer it.
