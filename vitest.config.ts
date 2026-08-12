/**
 * Default config: everything except tests/db/**, which needs a live Postgres (docker compose up
 * postgres; npm run test:db) and must never silently run — or silently skip — as part of the
 * fast, DB-free `npm run test` this project treats as the default gate.
 */
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'tests/db/**'],
  },
});
