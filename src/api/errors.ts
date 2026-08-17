/**
 * One error shape for the whole API: `{ error: { code, message } }`.
 *
 * A single shape rather than a per-route one because three clients consume this — web, ICS and a
 * native iOS app (NFR-1) — and each one that has to special-case an error format is a place the
 * API turns out to have been shaped for whoever was written first.
 */

import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

export type ApiErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'not_found'
  | 'internal';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static badRequest(message: string): ApiError {
    return new ApiError(400, 'bad_request', message);
  }

  /**
   * The only 401 in the codebase, and deliberately the only one.
   *
   * SPEC §8's stage 2b criterion: a request with no token, a malformed token, or an unknown token
   * must be rejected "without leaking whether the token existed". So there is no `token_expired`,
   * no `token_missing`, and no variation in the message — a caller must not be able to use the
   * error to probe which tokens are real.
   */
  static unauthorized(): ApiError {
    return new ApiError(401, 'unauthorized', 'a valid bearer token is required');
  }

  static notFound(message: string): ApiError {
    return new ApiError(404, 'not_found', message);
  }
}

export interface ErrorBody {
  error: { code: ApiErrorCode; message: string };
}

function body(code: ApiErrorCode, message: string): ErrorBody {
  return { error: { code, message } };
}

/**
 * The terminal error handler.
 *
 * Express only recognises a middleware as an error handler if it declares exactly four parameters
 * and is registered last — verified against the Express 5 documentation. `next` is therefore
 * unused on purpose and named for the linter's `argsIgnorePattern`.
 *
 * Express 5 forwards a rejected promise from an async route handler here automatically, which is
 * why no route in this directory has a try/catch: in Express 4 the same code would have hung the
 * request instead.
 */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ApiError) {
    res.status(err.status).json(body(err.code, err.message));
    return;
  }

  if (err instanceof ZodError) {
    // Reached only if a schema is parsed outside `parseOrThrow`; kept so a stray Zod failure is a
    // 400 with a usable message rather than an opaque 500.
    res.status(400).json(body('bad_request', formatZodError(err)));
    return;
  }

  // Anything else is ours, not the caller's. The message is deliberately not `err.message`: a
  // `pg` error carries table and column names, and a stack trace carries filesystem paths.
  // Neither belongs in a response to an anonymous client.
  process.stderr.write(
    `[api] unhandled: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  res.status(500).json(body('internal', 'internal error'));
}

export function formatZodError(err: ZodError): string {
  return err.issues
    .map((issue) => {
      const path = issue.path.join('.');
      return path === '' ? issue.message : `${path}: ${issue.message}`;
    })
    .join('; ');
}

/** 404 for an unrouted path, in the same shape as everything else. Registered before `errorHandler`. */
export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json(body('not_found', 'no such endpoint'));
}
