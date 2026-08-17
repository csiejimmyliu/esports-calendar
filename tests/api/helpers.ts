/**
 * Test harness for the API: a real Express app on a real ephemeral port, driven by Node's global
 * `fetch`.
 *
 * No `supertest`. Two reasons, and the second is the one that matters. It would be a dependency
 * this repo does not need — Node 22 has `fetch` — and it drives the app in-process, which means a
 * route can pass its test while being unreachable over the wire. NFR-1 says every capability must
 * be available over JSON to a native client; a test that never opens a socket cannot show that.
 */

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Pool } from 'pg';

import { createApp } from '../../src/api/app.js';

export interface TestApi {
  baseUrl: string;
  close: () => Promise<void>;
}

export async function startApi(pool: Pool): Promise<TestApi> {
  const server: Server = await new Promise((resolve) => {
    const s = createApp(pool).listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export interface Json {
  status: number;
  body: unknown;
  /** The raw text, so a test can assert two error responses are byte-identical. */
  raw: string;
}

/**
 * One request. `token` becomes an `Authorization: Bearer` header and nothing else — there is no
 * cookie jar here at all, which is how the suite asserts structurally that no route depends on one.
 */
export async function call(
  api: TestApi,
  method: string,
  path: string,
  options: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Json> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.token !== undefined) headers['authorization'] = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  const res = await fetch(`${api.baseUrl}${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const raw = await res.text();
  return { status: res.status, body: raw === '' ? null : JSON.parse(raw), raw };
}
