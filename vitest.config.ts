/**
 * Default config: everything except tests/db/** and tests/api/**, both of which need a live
 * Postgres (docker compose up postgres; npm run test:db) and must never silently run — or silently
 * skip — as part of the fast, DB-free `npm run test` this project treats as the default gate.
 *
 * tests/api/** joined the exclusion in stage 2b: it starts a real Express server on an ephemeral
 * port and talks to it over HTTP, so it is a DB-backed integration suite wearing a different name.
 */
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'tests/db/**', 'tests/api/**'],
  },
});
