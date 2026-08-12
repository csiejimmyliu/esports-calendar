-- Stage 1b: health/canary recording. `source_health` and `sync_run` were created empty in
-- 001_init.sql (see its header); this migration adds the columns and table their first writer
-- (src/sync/health.ts) needs.

-- A run's warning volume, for the same reason `source_health.last_item_count` exists: a run that
-- "succeeds" but logs 40 new `team-unresolved` warnings is a different signal from one that logs
-- zero, and neither is visible from `status` alone.
ALTER TABLE sync_run ADD COLUMN warning_count INTEGER;
-- Free-text failure detail. `status` is queryable/filterable vocabulary ('ok' | 'degraded' |
-- 'failed'); `detail` is for a human reading one row, same split as SourceCanary.description vs.
-- CanaryResult.ok.
ALTER TABLE sync_run ADD COLUMN detail TEXT;

-- One row per canary check per run. Not keyed to sync_run.id: a canary is evaluated per scope
-- (src/core/source.ts's SourceCanary.scopeKey) inside a run that may cover several scopes, and
-- keeping the source_id/canary_key/checked_at triple queryable directly ("when did
-- schedule-has-upcoming last fail for riot-rest-lol") matters more here than the join to the run
-- that produced it.
CREATE TABLE canary_result (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  source_id TEXT NOT NULL REFERENCES source (id),
  canary_key TEXT NOT NULL,
  ok BOOLEAN NOT NULL,
  detail TEXT NOT NULL,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX canary_result_source_key_idx ON canary_result (source_id, canary_key, checked_at DESC);
