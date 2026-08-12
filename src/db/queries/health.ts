import type { Pool, PoolClient } from 'pg';

export type SyncRunStatus = 'running' | 'ok' | 'degraded' | 'failed';

/**
 * `pool.query` rather than a `PoolClient` — see src/sync/health.ts. Each call here is a single
 * statement, so it needs no explicit transaction of its own, and using the pool directly (instead
 * of the ingest transaction's client) is what lets a health/run record survive a rolled-back
 * ingest.
 */
export async function startSyncRun(pool: Pool, sourceId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO sync_run (source_id, started_at, status) VALUES ($1, now(), 'running') RETURNING id`,
    [sourceId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('startSyncRun: INSERT ... RETURNING produced no row');
  return row.id;
}

export async function finishSyncRun(
  pool: Pool,
  runId: string,
  status: Exclude<SyncRunStatus, 'running'>,
  itemCount: number,
  warningCount: number,
  detail: string | null,
): Promise<void> {
  await pool.query(
    `UPDATE sync_run SET finished_at = now(), status = $2, item_count = $3, warning_count = $4, detail = $5
     WHERE id = $1`,
    [runId, status, itemCount, warningCount, detail],
  );
}

export interface SourceHealthRow {
  sourceId: string;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  consecutiveFailures: number;
  lastItemCount: number | null;
  status: string;
}

export async function getSourceHealth(pool: Pool, sourceId: string): Promise<SourceHealthRow | null> {
  const { rows } = await pool.query<{
    source_id: string;
    last_success_at: string | null;
    last_failure_at: string | null;
    consecutive_failures: number;
    last_item_count: number | null;
    status: string;
  }>(
    `SELECT source_id, last_success_at, last_failure_at, consecutive_failures, last_item_count, status
     FROM source_health WHERE source_id = $1`,
    [sourceId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    sourceId: row.source_id,
    lastSuccessAt: row.last_success_at,
    lastFailureAt: row.last_failure_at,
    consecutiveFailures: row.consecutive_failures,
    lastItemCount: row.last_item_count,
    status: row.status,
  };
}

/**
 * `succeeded` means "data flowed" — true for both `ok` and `degraded` run status. Only a `failed`
 * run (nothing ingested) counts against `consecutive_failures`; a degraded run resets it, because
 * a calendar with a failed canary is still a calendar, not an outage.
 */
export async function recordSourceHealth(
  pool: Pool,
  sourceId: string,
  succeeded: boolean,
  itemCount: number,
  status: SyncRunStatus,
): Promise<void> {
  const current = await getSourceHealth(pool, sourceId);
  const consecutiveFailures = succeeded ? 0 : (current?.consecutiveFailures ?? 0) + 1;
  await pool.query(
    `INSERT INTO source_health (source_id, last_success_at, last_failure_at, consecutive_failures, last_item_count, status)
     VALUES ($1, CASE WHEN $2 THEN now() ELSE $6 END, CASE WHEN $2 THEN $7 ELSE now() END, $3, $4, $5)
     ON CONFLICT (source_id) DO UPDATE SET
       last_success_at = EXCLUDED.last_success_at,
       last_failure_at = EXCLUDED.last_failure_at,
       consecutive_failures = EXCLUDED.consecutive_failures,
       last_item_count = EXCLUDED.last_item_count,
       status = EXCLUDED.status`,
    [sourceId, succeeded, consecutiveFailures, itemCount, status, current?.lastSuccessAt ?? null, current?.lastFailureAt ?? null],
  );
}

export async function insertCanaryResult(
  client: Pool | PoolClient,
  sourceId: string,
  canaryKey: string,
  ok: boolean,
  detail: string,
): Promise<void> {
  await client.query(
    `INSERT INTO canary_result (source_id, canary_key, ok, detail) VALUES ($1, $2, $3, $4)`,
    [sourceId, canaryKey, ok, detail],
  );
}
