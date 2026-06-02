// Tiny exponential-backoff helper. Used by the CacheClient REST layer to
// retry transient failures (5xx, 429, network errors) before surfacing them
// to the orchestration in save/restore main.ts.

import { debug } from "../log/logger.js";

export class RetryError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "RetryError";
  }
}

export interface RetryOptions {
  /** Maximum attempt count (including the first call). */
  maxAttempts: number;
  /** Base delay in milliseconds. Doubled on each retry. */
  baseDelayMs: number;
  /**
   * Predicate that decides whether a thrown error should be retried.
   * When provided, replaces the default
   * `err instanceof RetryError && err.retryable` check — useful for
   * callers (like CacheClient) whose error type is not RetryError.
   */
  isRetryable?: (err: unknown) => boolean;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  const isRetryable =
    opts.isRetryable ??
    ((err: unknown) => err instanceof RetryError && err.retryable);

  let lastErr: unknown;
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err)) {
        throw err;
      }
      if (attempt >= opts.maxAttempts) break;
      const delay = opts.baseDelayMs * Math.pow(2, attempt - 1);
      debug(
        `retry: attempt ${attempt}/${opts.maxAttempts} failed (retryable), backing off ${delay}ms: ${(err as Error).message}`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
