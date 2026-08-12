/**
 * Migration runner: numbered .sql files in migrations/, applied in order, each in its own
 * transaction, recorded in `schema_migration`.
 *
 * Hand-written rather than a framework. CLAUDE.md: ask before adding a dependency, and a
 * migration framework buys nothing here that ~50 lines does not -- this repo already prefers
 * hand-written tooling (scripts/capture-lib.ts) over pulling one in for something this small.
 *
 *   npm run migrate
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { Pool } from 'pg';

import { createPool } from './pool.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

async function ensureMigrationsTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

/** Applies every .sql file in migrations/ not yet recorded in schema_migration. Returns their names. */
export async function migrate(pool: Pool): Promise<string[]> {
  await ensureMigrationsTable(pool);

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await pool.query<{ version: string }>('SELECT version FROM schema_migration');
  const applied = new Set(rows.map((r) => r.version));

  const newlyApplied: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migration (version) VALUES ($1)', [file]);
      await client.query('COMMIT');
      newlyApplied.push(file);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      client.release();
    }
  }
  return newlyApplied;
}

async function main(): Promise<void> {
  const pool = createPool();
  try {
    const applied = await migrate(pool);
    process.stdout.write(
      applied.length === 0 ? 'no pending migrations\n' : `applied: ${applied.join(', ')}\n`,
    );
  } finally {
    await pool.end();
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exitCode = 1;
  });
}
