-- Stage 2a: the anonymous bearer credential (SPEC §2 FR-1, §5).
--
-- An anonymous user is an `app_user` row with email IS NULL -- created in 001_init.sql, no DDL
-- needed here. What was missing is somewhere to put the credential that addresses it.
--
-- A table rather than a column on app_user, for two reasons. One user may legitimately hold more
-- than one live token (a second device, or a rotation), so each is an insert instead of a schema
-- change. And the credential stays out of the row that `SELECT * FROM app_user` returns.
--
-- Deliberately NOT merged with ics_token, which 001_init.sql already created. Different power
-- (full write vs read-only) and different exposure (an Authorization header vs a URL that Google
-- Calendar stores in plaintext and its servers log). One shared value would turn a read-only leak
-- into a write compromise. CLAUDE.md carries this as a non-negotiable.

CREATE TABLE user_token (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app_user (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Lookup by token is the hot path and is served by the primary key. This index serves the other
-- direction: revoking or listing a user's tokens, which stage 4's account merge needs.
CREATE INDEX user_token_user_idx ON user_token (user_id);

-- The overview's backward paging (SPEC §2 FR-2) is a keyset scan on (starts_at_utc, id), in both
-- directions. Without this the query degrades to a full scan plus sort on every page.
CREATE INDEX match_starts_at_idx ON match (starts_at_utc, id);

-- Reading one user's calendar reads all their selections. The primary key (user_id, match_id)
-- already leads with user_id, so no extra index is needed there; follow's primary key
-- (user_id, target_type, target_id) does the same for follows.
