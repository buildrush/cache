// Shared TypeScript types for the Build_Rush Cache wrapper action.
// Mirrors the wire shapes documented in the cache-service spec §5.

/** Request body for POST /api/cache/auth/exchange. */
export interface ExchangeRequest {
  /** OIDC audience the runner minted the identity token with. */
  audience: string;
}

/** 200 response body for POST /api/cache/auth/exchange. */
export interface ExchangeResponse {
  /** Cache access token (JWT) — pass on subsequent calls via Authorization: Bearer <token>. */
  token: string;
}

/** Request body for POST /api/cache/entries (reserve a write slot). */
export interface CreateRequest {
  key: string;
  version: string;
  /** Declared archive size in bytes. */
  sizeBytes: number;
}

/** 200 response body for POST /api/cache/entries. */
export interface CreateResponse {
  /** Vanilla HTTP PUT target. Single signed URL or resumable session URI — the wrapper does not need to know which. */
  uploadUrl: string;
}

/** Request body for POST /api/cache/entries/finalize. */
export interface FinalizeRequest {
  key: string;
  version: string;
  sizeBytes: number;
}

/** Request body for POST /api/cache/entries/lookup. */
export interface LookupRequest {
  key: string;
  version: string;
  restoreKeys: string[];
}

/** 200 response body for POST /api/cache/entries/lookup. Empty object on miss. */
export interface LookupResponse {
  downloadUrl?: string;
  matchedKey?: string;
}

/** Non-2xx error envelope shape (BR-standard). */
export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

/** End-to-end outcome of a restore download+extract (F1b read_complete). */
export type RestoreOutcome = "ok" | "download_failed" | "extract_failed";

/**
 * Request body for POST /api/cache/telemetry (best-effort read_complete row).
 * Scope (installation/repo/ref/run) is derived server-side from the cache JWT,
 * never sent here. Nullable fields reflect partial failures (a download_failed
 * row has clientBytes / clientThroughput / decompressMs null).
 *
 * Golden vector pinned in __tests__/client/cacheClient.test.ts; sister Go test:
 * service/action/cache/tests/repository/event_log_test.go
 * (TestCacheEventLog_AppendReadComplete) — keep both in sync with design §5.
 */
export interface TelemetryRequest {
  key: string;
  version: string;
  /** The key lookup actually matched (exact or a restore-key prefix). */
  matchedKey: string;
  clientDurationMs: number | null;
  clientBytes: number | null;
  clientThroughput: number | null;
  decompressMs: number | null;
  outcome: RestoreOutcome;
}
