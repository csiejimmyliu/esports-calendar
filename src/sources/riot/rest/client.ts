/**
 * HTTP access to Riot's REST esports API. The only file in the adapter that touches the network.
 *
 * Base: https://esports-api.lolesports.com/persisted/gw/
 * Auth: a static, publicly documented x-api-key, unchanged for years.
 *
 * The title is selected by the path segment `/persisted/{gw|val}/` — the domain is an alias and
 * the `sport` query parameter is ignored, so `gw` here means LoL regardless of hostname.
 */

import { RiotErrorEnvelope } from './dto.js';

export const RIOT_REST_BASE = 'https://esports-api.lolesports.com/persisted/gw';

/**
 * Identity locale, pinned.
 *
 * Response content varies by `hl`: blockName and tournament.name come back translated. Identity
 * must be resolved from one fixed locale or the same tournament is two entities depending on who
 * asked. Display names are a separate concern from identity.
 */
export const IDENTITY_LOCALE = 'en-US';

export class RiotApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = 'RiotApiError';
  }
}

export interface RiotRestClientOptions {
  apiKey: string;
  userAgent: string;
  baseUrl?: string;
  maxAttempts?: number;
  /** Injected so retry backoff does not make tests wait in real time. */
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}

export interface RawResponse {
  json: unknown;
  bytes: number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export class RiotRestClient {
  readonly #apiKey: string;
  readonly #userAgent: string;
  readonly #baseUrl: string;
  readonly #maxAttempts: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #fetch: typeof fetch;

  constructor(opts: RiotRestClientOptions) {
    this.#apiKey = opts.apiKey;
    this.#userAgent = opts.userAgent;
    this.#baseUrl = opts.baseUrl ?? RIOT_REST_BASE;
    this.#maxAttempts = opts.maxAttempts ?? 3;
    this.#sleep = opts.sleep ?? defaultSleep;
    this.#fetch = opts.fetchImpl ?? fetch;
  }

  async get(endpoint: string, params: Record<string, string> = {}): Promise<RawResponse> {
    const url = new URL(`${this.#baseUrl}/${endpoint}`);
    url.searchParams.set('hl', IDENTITY_LOCALE);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    let lastError: unknown;
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      try {
        return await this.#attempt(url);
      } catch (err) {
        lastError = err;
        // A 4xx that is not rate limiting will not become a 200 by asking again.
        if (err instanceof RiotApiError && err.status !== null && err.status < 500 && err.status !== 429) {
          throw err;
        }
        if (attempt < this.#maxAttempts) {
          // Polite backoff. The repo is public, so the request volume has to be defensible.
          await this.#sleep(500 * 2 ** (attempt - 1));
        }
      }
    }
    throw lastError instanceof Error ? lastError : new RiotApiError(String(lastError), null);
  }

  async #attempt(url: URL): Promise<RawResponse> {
    const res = await this.#fetch(url, {
      headers: {
        'x-api-key': this.#apiKey,
        'user-agent': this.#userAgent,
        accept: 'application/json',
      },
    });

    const text = await res.text();
    if (!res.ok) {
      throw new RiotApiError(`${url.pathname} returned HTTP ${String(res.status)}`, res.status);
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new RiotApiError(`${url.pathname} returned non-JSON body`, res.status);
    }

    /**
     * Check for `errors` *before* reading `data`. Riot reports failure as HTTP 200 with an
     * `errors` array and no `data` key at all. A parser that reaches for `data` first sees
     * undefined, reports zero rows, and every health check stays green while the calendar
     * empties — the precise failure mode this project is built around.
     */
    const asError = RiotErrorEnvelope.safeParse(json);
    if (asError.success) {
      const messages = asError.data.errors.map((e) => e.message).join('; ');
      throw new RiotApiError(`${url.pathname} returned an error envelope: ${messages}`, res.status);
    }

    return { json, bytes: text.length };
  }
}
