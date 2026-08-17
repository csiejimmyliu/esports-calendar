/**
 * DB-backed tests only. `docker compose up -d db && npm run test:db` — requires DATABASE_URL to
 * point at a running Postgres with migrations applied; these tests fail loudly rather than skip
 * when it's absent (see tests/db/setup.ts), matching this repo's "no silently-skipping
 * integration test" rule.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // tests/api/** belongs here rather than in `npm run test`: it drives a real Express app over a
    // real socket against a real Postgres, so it has the same "fail loudly without DATABASE_URL"
    // contract as tests/db/**.
    include: ['tests/db/**/*.test.ts', 'tests/api/**/*.test.ts'],
    fileParallelism: false,
  },
});
