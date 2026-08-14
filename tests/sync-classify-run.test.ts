/**
 * `classifyRun` (src/sync/ingest.ts) has a doc comment directly above it stating the intended
 * mapping from a SyncReport to a run status:
 *
 *   "ok" — every scope processed, every canary passed.
 *   "degraded" — some data was ingested but a scope failed or a canary did not pass.
 *   "failed" — nothing was ingested at all (fatal, or every scope failed).
 *
 * This file pins that mapping directly, branch by branch, plus the precedence between branches
 * (the function is a sequence of early returns, so which condition is checked first is itself
 * part of the contract: a fatal report must stay "failed" even if it also has canary failures or
 * scope failures that would otherwise read as "degraded").
 *
 * The zero-scopes case (`scopesProcessed === 0 && scopesFailed === 0`, e.g. `listScopes()`
 * resolved to `[]`) is deliberately not asserted here — see the "Cells I would not pin" note in
 * the report that accompanies this file. Nothing in the doc comment, SPEC.md, or CLAUDE.md states
 * what a zero-scope run should classify as, and the current code returns "ok" for it by falling
 * through every branch, which is exactly the kind of undocumented behaviour this test suite is
 * told not to rubber-stamp.
 */
import { describe, expect, it } from 'vitest';

import { classifyRun } from '../src/sync/ingest.js';
import type { CanaryOutcome, ScopeFailure, SyncReport } from '../src/sync/ingest.js';

const BASE_REPORT: SyncReport = {
  sourceId: 'riot-rest-lol',
  scopesProcessed: 0,
  scopesFailed: 0,
  scopeFailures: [],
  fatal: null,
  matchesFetched: 0,
  leaguesUpserted: 0,
  teamsUpserted: 0,
  matchesInserted: 0,
  matchesUpdated: 0,
  matchesUnchanged: 0,
  matchesCancelled: 0,
  warnings: [],
  canaryResults: [],
};

const OK_CANARY: CanaryOutcome = { key: 'lck-has-matches', scopeKey: 'lck', ok: true, detail: 'ok' };
const FAILED_CANARY: CanaryOutcome = { key: 'lck-has-matches', scopeKey: 'lck', ok: false, detail: 'no rows' };

const SCOPE_FAILURE: ScopeFailure = { scopeKey: 'lck', message: 'boom' };

describe('classifyRun', () => {
  it('returns "failed" when the report has a fatal error, regardless of scope/canary counts', () => {
    const report: SyncReport = {
      ...BASE_REPORT,
      fatal: 'listScopes threw',
      scopesProcessed: 5,
      scopesFailed: 0,
      canaryResults: [OK_CANARY],
    };
    expect(classifyRun(report)).toBe('failed');
  });

  it('returns "failed" when fatal is set even though scopeFailed would independently read as degraded', () => {
    // Precedence check: scopesFailed > 0 alone (with scopesProcessed > 0) would be "degraded" per
    // the branch below, but a fatal report must win. If the `fatal` check were removed or reordered
    // after the scopesFailed check, this would flip from 'failed' to 'degraded'.
    const report: SyncReport = {
      ...BASE_REPORT,
      fatal: 'registry write failed',
      scopesProcessed: 3,
      scopesFailed: 2,
      scopeFailures: [SCOPE_FAILURE],
    };
    expect(classifyRun(report)).toBe('failed');
  });

  it('returns "failed" when no scope was processed and at least one scope failed', () => {
    const report: SyncReport = {
      ...BASE_REPORT,
      scopesProcessed: 0,
      scopesFailed: 3,
      scopeFailures: [SCOPE_FAILURE],
    };
    expect(classifyRun(report)).toBe('failed');
  });

  it('returns "degraded" when some scopes processed and some failed (partial ingestion)', () => {
    const report: SyncReport = {
      ...BASE_REPORT,
      scopesProcessed: 4,
      scopesFailed: 1,
      scopeFailures: [SCOPE_FAILURE],
    };
    expect(classifyRun(report)).toBe('degraded');
  });

  it('returns "degraded" when every scope processed but a canary did not pass', () => {
    const report: SyncReport = {
      ...BASE_REPORT,
      scopesProcessed: 8,
      scopesFailed: 0,
      canaryResults: [OK_CANARY, FAILED_CANARY],
    };
    expect(classifyRun(report)).toBe('degraded');
  });

  it('returns "ok" when every scope processed and every canary passed', () => {
    const report: SyncReport = {
      ...BASE_REPORT,
      scopesProcessed: 8,
      scopesFailed: 0,
      canaryResults: [OK_CANARY, OK_CANARY],
    };
    expect(classifyRun(report)).toBe('ok');
  });
});
