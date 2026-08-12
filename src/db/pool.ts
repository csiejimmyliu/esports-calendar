/**
 * The single pg Pool for a process.
 *
 * No embedded or in-memory fallback: DATABASE_URL missing is a loud failure, not a silent
 * degrade, matching the pattern this repo already uses for RIOT_ESPORTS_API_KEY
 * (src/cli/next-matches.ts) and every capture script (CLAUDE.md).
 */

import { Pool } from 'pg';

export function createPool(connectionString = process.env['DATABASE_URL']): Pool {
  if (connectionString === undefined || connectionString === '') {
    throw new Error('DATABASE_URL is not set; see .env.example');
  }
  return new Pool({ connectionString });
}
