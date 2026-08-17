/**
 * The API process.
 *
 *   npm run serve
 *
 * Everything it needs comes from the environment: `DATABASE_URL` (required — `createPool` fails
 * loudly without it) and `PORT`. Nothing else, because a stateless tier that reads configuration
 * from anywhere else cannot be started twice on one machine, which is what stage 9 will do.
 */

import process from 'node:process';

import { createApp } from './app.js';
import { createPool } from '../db/pool.js';

const DEFAULT_PORT = 3000;

function main(): void {
  const pool = createPool();
  const port = Number(process.env['PORT'] ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`PORT is not a valid port number: ${String(process.env['PORT'])}`);
  }

  const server = createApp(pool).listen(port, () => {
    process.stdout.write(`api listening on :${port}\n`);
  });

  // The web tier holds no user state, so a shutdown has nothing to flush — it only has to stop
  // accepting and let in-flight requests finish, which is what NFR-6 buys.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      server.close(() => {
        void pool.end().then(() => process.exit(0));
      });
    });
  }
}

main();
