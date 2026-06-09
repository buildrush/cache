// Thin REST client for the Build_Rush cache service. Wraps fetch() with
// JSON encoding, Bearer-token auth, and error envelope parsing. Each
// public method is wrapped in withRetry() so transient failures (5xx,
// 429, network errors — anything CacheClientError marks retryable=true)
// are retried with exponential backoff before bubbling to the caller.

import { withRetry } from "../retry/retry.js";
import { debug } from "../log/logger.js";
import type {
  CreateRequest,
  CreateResponse,
  ErrorEnvelope,
  FinalizeRequest,
  LookupRequest,
  LookupResponse,
  TelemetryRequest,
} from "../types.js";

export class CacheClientError extends Error {
  public override readonly name = "CacheClientError";
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const DEFAULT_BASE_DELAY_MS = 200;
const DEFAULT_TELEMETRY_TIMEOUT_MS = 2500;

export interface CacheClientOptions {
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Override retry base delay in milliseconds. Defaults to 200; tests typically pass 1 to keep the suite fast. */
  baseDelayMs?: number;
  /**
   * Hard per-call deadline for the best-effort telemetry POST, in
   * milliseconds. Defaults to 2500. Telemetry is single-attempt and bounded
   * by this timeout so a hung endpoint can never stall the cache step; tests
   * pass a small value to exercise the abort path quickly.
   */
  telemetryTimeoutMs?: number;
}

export interface LookupHit {
  downloadUrl: string;
  matchedKey: string;
}

export class CacheClient {
  private readonly fetchImpl: typeof fetch;
  private readonly telemetryTimeoutMs: number;
  private readonly retryOpts: {
    maxAttempts: number;
    baseDelayMs: number;
    isRetryable: (err: unknown) => boolean;
  };

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    opts: CacheClientOptions = {},
  ) {
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.telemetryTimeoutMs =
      opts.telemetryTimeoutMs ?? DEFAULT_TELEMETRY_TIMEOUT_MS;
    this.retryOpts = {
      maxAttempts: 3,
      baseDelayMs: opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
      isRetryable: (err: unknown) =>
        err instanceof CacheClientError && err.retryable,
    };
  }

  /**
   * POST /api/cache/telemetry → resolves on 204. Best-effort, so unlike every
   * other endpoint it is SINGLE-attempt (no retry budget) and hard-bounded by
   * telemetryTimeoutMs: telemetry must never stall or fail the cache step. The
   * CALLER wraps this in try/catch so any throw (timeout, 4xx, 5xx, network)
   * is swallowed to a debug log.
   */
  async reportTelemetry(req: TelemetryRequest): Promise<void> {
    await this.post("/api/cache/telemetry", req, {
      expectStatus: 204,
      timeoutMs: this.telemetryTimeoutMs,
    });
  }

  /** POST /api/cache/entries → returns the uploadUrl on success. */
  async createEntry(req: CreateRequest): Promise<string> {
    return withRetry(async () => {
      const resp = await this.post("/api/cache/entries", req);
      const body = (await resp.json()) as CreateResponse;
      if (!body || typeof body.uploadUrl !== "string" || body.uploadUrl === "") {
        throw new CacheClientError(
          "create response missing uploadUrl",
          resp.status,
          "PROTOCOL_ERROR",
          false,
        );
      }
      return body.uploadUrl;
    }, this.retryOpts);
  }

  /** POST /api/cache/entries/finalize → resolves on 204. */
  async finalizeEntry(req: FinalizeRequest): Promise<void> {
    await withRetry(
      async () => {
        await this.post("/api/cache/entries/finalize", req, {
          expectStatus: 204,
        });
      },
      {
        ...this.retryOpts,
        // A finalize 429 is the per-repo / per-installation quota (overcommit)
        // rejection, never a rate limit — the cache service rate-limits only
        // createEntry. Retrying cannot clear a quota breach, and a retry would
        // let the server's saga compensation delete the reservation, turning
        // the next attempt into a misleading 404 "reservation not found". So
        // treat a finalize 429 as terminal and surface the real quota error to
        // the caller immediately.
        isRetryable: (err) =>
          err instanceof CacheClientError &&
          err.retryable &&
          err.status !== 429,
      },
    );
  }

  /** POST /api/cache/entries/lookup → returns the hit or null on miss. */
  async lookupEntry(req: LookupRequest): Promise<LookupHit | null> {
    return withRetry(async () => {
      const resp = await this.post("/api/cache/entries/lookup", req);
      const body = (await resp.json()) as LookupResponse;
      if (!body.downloadUrl) return null;
      return { downloadUrl: body.downloadUrl, matchedKey: body.matchedKey ?? "" };
    }, this.retryOpts);
  }

  private async post(
    path: string,
    body: unknown,
    opts: { expectStatus?: number; timeoutMs?: number } = {},
  ): Promise<Response> {
    // A hard deadline (telemetry only) aborts the fetch if the endpoint hangs;
    // AbortSignal.timeout's timer is unref'd so it never keeps the process alive.
    const signalInit =
      opts.timeoutMs !== undefined
        ? { signal: AbortSignal.timeout(opts.timeoutMs) }
        : {};
    let resp: Response;
    try {
      resp = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(body),
        ...signalInit,
      });
    } catch (err) {
      throw new CacheClientError(
        `network error: ${(err as Error).message}`,
        0,
        "NETWORK_ERROR",
        true,
      );
    }

    // Status only — never the URL (no secrets) or body (may carry signed URLs).
    debug(`http: POST ${path} → ${resp.status}`);

    if (opts.expectStatus !== undefined) {
      if (resp.status !== opts.expectStatus) {
        await this.throwFromResponse(resp);
      }
      return resp;
    }
    if (!resp.ok) {
      await this.throwFromResponse(resp);
    }
    return resp;
  }

  private async throwFromResponse(resp: Response): Promise<never> {
    let envelope: ErrorEnvelope | null = null;
    try {
      envelope = (await resp.json()) as ErrorEnvelope;
    } catch {
      envelope = null;
    }
    const code = envelope?.error?.code ?? "UNKNOWN_ERROR";
    const message = envelope?.error?.message ?? `cache service: ${resp.status}`;
    const retryable = resp.status >= 500 || resp.status === 429;
    throw new CacheClientError(
      message,
      resp.status,
      code,
      retryable,
      envelope?.error?.details,
    );
  }
}
