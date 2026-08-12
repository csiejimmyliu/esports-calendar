-- Stage 1a: initial schema. Transcribes docs/SPEC.md §5, with deviations noted inline.
--
-- Applied by src/db/migrate.ts, which owns schema_migration itself (CREATE TABLE IF NOT EXISTS,
-- run before this file) so that table is not duplicated here.
--
-- `source_health` and `sync_run` are created here even though nothing writes them until stage
-- 1b: splitting one schema across two migration files for a session boundary is worse than one
-- file. `selection`, `follow`, `stream_pref`, `notification_rule`, `device`, `ics_token` are
-- created empty for the same reason -- `selection` in particular is needed now as an NFR-8 test
-- target ("a user's explicit selection is never overwritten by sync"), and creating it later
-- would be a migration for no benefit. Stage 2 is their first writer.

-- ---------------------------------------------------------------------------
-- Registry
-- ---------------------------------------------------------------------------

-- `id` is the human-readable slug itself ('lol', 'riot-rest-lol'), not a surrogate uuid. These
-- are small, hand-registered tables (src/sync/registry.ts is a plain map, not discovery), unlike
-- league/team/tournament/match below, which are crosswalked per-source entities and do need
-- surrogate ids.
CREATE TABLE game (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL
);

CREATE TABLE source (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  organizer TEXT NOT NULL,
  base_url TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true
);

-- Not written until stage 1b (source health + canary scheduling). Queryable staleness is NFR-5.
CREATE TABLE source_health (
  source_id TEXT PRIMARY KEY REFERENCES source (id),
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_item_count INTEGER,
  status TEXT NOT NULL DEFAULT 'unknown'
);

-- Not written until stage 1b.
CREATE TABLE sync_run (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  source_id TEXT NOT NULL REFERENCES source (id),
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  item_count INTEGER,
  status TEXT NOT NULL DEFAULT 'running'
);

-- ---------------------------------------------------------------------------
-- Domain
-- ---------------------------------------------------------------------------

CREATE TYPE league_tier AS ENUM ('major', 'minor', 'unclassified');

-- `kind` has no NOT NULL: an unclassified league legitimately has none. The invariant that every
-- *covered* (major) league must declare one is enforced in src/config/leagues.ts at parse time,
-- same as it is for config/leagues.json today -- not duplicated here as a constraint, because the
-- rule is about coverage (a product decision), not about what the column can hold.
CREATE TYPE league_kind AS ENUM ('region', 'event');

CREATE TABLE league (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  game_id TEXT NOT NULL REFERENCES game (id),
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  region TEXT,
  image_url TEXT,
  tier league_tier NOT NULL,
  kind league_kind,
  default_stream_url TEXT,
  UNIQUE (game_id, slug)
);

CREATE TABLE tournament (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  league_id TEXT REFERENCES league (id),
  name TEXT NOT NULL,
  starts_on DATE,
  ends_on DATE
);

-- SPEC §5 lists `slug` on team; no probed source currently supplies one (src/core/types.ts's
-- `Team` has no slug field), so it stays nullable and unpopulated rather than invented.
CREATE TABLE team (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  game_id TEXT NOT NULL REFERENCES game (id),
  slug TEXT,
  name TEXT NOT NULL,
  code TEXT,
  image_url TEXT
);

-- `cancelled` is real vocabulary (src/core/types.ts) even though the one adapter that exists
-- cannot yet produce it via its own state field -- ingest.ts derives it from a match's absence
-- from a complete crawl. See diffMatch / detectCancellations in src/sync/.
CREATE TYPE match_state AS ENUM ('unstarted', 'inProgress', 'completed', 'cancelled');

CREATE TABLE match (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tournament_id TEXT REFERENCES tournament (id),
  league_id TEXT REFERENCES league (id),
  starts_at_utc TIMESTAMPTZ NOT NULL,
  best_of INTEGER,
  games_played INTEGER NOT NULL DEFAULT 0,
  block_name TEXT,
  state match_state NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  -- No ends_at_utc column. Deliberate -- SPEC §1: Riot supplies no end time, duration is an
  -- estimate computed from best_of at the render boundary, and persisting the estimate would
  -- launder a guess into the data model where the next reader could not tell it from a
  -- measurement. The only persisted instant is starts_at_utc.
);

-- `side_index` (0 or 1), not `home`/`away`: esports series have no home/away semantic, and SPEC's
-- own MatchSide tuple (src/core/types.ts) is positional, not labelled. Matches that positional
-- order verbatim rather than inventing a label that would mean nothing for this domain.
CREATE TABLE match_team (
  match_id TEXT NOT NULL REFERENCES match (id) ON DELETE CASCADE,
  side_index SMALLINT NOT NULL CHECK (side_index IN (0, 1)),
  team_id TEXT REFERENCES team (id), -- NULL means TBD (SourceSide.team === null)
  score INTEGER,
  PRIMARY KEY (match_id, side_index)
);

-- Created, never written in stage 1a or 1b: Riot declares capabilities.streamUrls: false (FR-4),
-- so population here is hand-maintained data entry, not ingestion.
CREATE TABLE stream (
  match_id TEXT NOT NULL REFERENCES match (id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  channel TEXT NOT NULL,
  locale TEXT,
  is_official BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (match_id, provider, channel)
);

-- ---------------------------------------------------------------------------
-- Identity crosswalk
-- ---------------------------------------------------------------------------

CREATE TYPE entity_type AS ENUM ('league', 'tournament', 'team', 'match');

-- Keyed by (entity_type, source_id, game_id, external_id) -- the crosswalk's natural upsert key
-- and the thing that makes ingestion idempotent (src/sync/crosswalk.ts). `entity_id` is
-- deliberately not a foreign key: it points at whichever of league/tournament/team/match
-- `entity_type` names, and Postgres has no polymorphic FK.
--
-- `manual_override`: this row was set or confirmed by a human, so sync must not re-derive it.
-- Not the same thing as config/leagues.json's `teamOverrides`, which decides which team an
-- ambiguous *code* resolves to at parse time, inside the adapter, before any database exists.
-- SPEC §5 tabulates the difference.
CREATE TABLE external_ref (
  entity_type entity_type NOT NULL,
  entity_id TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES source (id),
  game_id TEXT NOT NULL REFERENCES game (id),
  external_id TEXT NOT NULL,
  is_canonical BOOLEAN NOT NULL DEFAULT true,
  manual_override BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (entity_type, source_id, game_id, external_id)
);

CREATE INDEX external_ref_entity_idx ON external_ref (entity_type, entity_id);

-- ---------------------------------------------------------------------------
-- User-facing tables — created now, empty. Stage 2 is their first writer.
-- ---------------------------------------------------------------------------

-- Named app_user, not user: `user` is a reserved word in PostgreSQL.
CREATE TABLE app_user (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TYPE follow_target AS ENUM ('league', 'team');

CREATE TABLE follow (
  user_id TEXT NOT NULL REFERENCES app_user (id),
  target_type follow_target NOT NULL,
  target_id TEXT NOT NULL,
  PRIMARY KEY (user_id, target_type, target_id)
);

CREATE TYPE selection_state AS ENUM ('included', 'excluded');

-- NFR-8: "a user's explicit selection is never overwritten by sync." Enforced by absence --
-- src/sync/ contains no reference to this table at all -- and asserted by
-- tests/db/sync-ingest.test.ts, not by a trigger or constraint here.
CREATE TABLE selection (
  user_id TEXT NOT NULL REFERENCES app_user (id),
  match_id TEXT NOT NULL REFERENCES match (id),
  state selection_state NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, match_id)
);

CREATE TYPE stream_pref_scope AS ENUM ('global', 'league', 'team');

CREATE TABLE stream_pref (
  user_id TEXT NOT NULL REFERENCES app_user (id),
  scope stream_pref_scope NOT NULL,
  scope_id TEXT,
  provider TEXT NOT NULL,
  channel TEXT NOT NULL,
  locale TEXT
);

CREATE TABLE notification_rule (
  user_id TEXT NOT NULL REFERENCES app_user (id),
  lead_minutes INTEGER NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true
);

CREATE TYPE device_platform AS ENUM ('web', 'ios');

CREATE TABLE device (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id TEXT NOT NULL REFERENCES app_user (id),
  platform device_platform NOT NULL,
  push_token TEXT NOT NULL
);

CREATE TABLE ics_token (
  user_id TEXT NOT NULL REFERENCES app_user (id),
  token TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
