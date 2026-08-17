/**
 * The Express application.
 *
 * `createApp` takes the pool rather than importing one, and does not listen. Both are for the same
 * reason: the tests bind it to port 0 against the test database and drive it with `fetch`, which
 * is what a real client does — no `supertest`, no in-process shortcut, and therefore no way for a
 * route to work in tests but not over the wire.
 *
 * No session store, no in-process user state: NFR-6, and stage 9 runs two or more instances behind
 * a load balancer where anything held in memory would be a coin flip.
 */

import express from 'express';
import type { Express } from 'express';
import type { Pool } from 'pg';

import { errorHandler, notFoundHandler } from './errors.js';
import { createIdentityRouter } from './routes/identity.js';
import { createMeRouter } from './routes/me.js';
import { createOverviewRouter } from './routes/overview.js';

export function createApp(pool: Pool): Express {
  const app = express();

  // Built into Express since 4.16 — no `body-parser` dependency. The limit is small because every
  // body this API accepts is a couple of short fields; a megabyte default would only ever serve an
  // attacker.
  app.use(express.json({ limit: '16kb' }));

  app.use('/v1', createIdentityRouter(pool));
  app.use('/v1', createOverviewRouter(pool));
  app.use('/v1/me', createMeRouter(pool));

  app.use(notFoundHandler);

  // Last, and with exactly four parameters, or Express does not treat it as an error handler.
  // Express 5 routes a rejected promise from any async handler above into it automatically, which
  // is why no handler in this directory has a try/catch around its logic.
  app.use(errorHandler);

  return app;
}
