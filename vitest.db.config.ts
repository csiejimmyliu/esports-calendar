/**
 * DB-backed tests only. `docker compose up -d db && npm run test:db` — requires DATABASE_URL to
 * point at a running Postgres with migrations applied; these tests fail loudly rather than skip
 * when it's absent (see tests/db/setup.ts), matching this repo's "no silently-skipping
 * integration test" rule.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/db/**/*.test.ts'],
    fileParallelism: false,
  },
});
