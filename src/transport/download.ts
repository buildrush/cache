// HTTP GET helper that streams the response body straight to disk.
// Used by the restore flow to fetch a cache archive from the signed URL.
//
// Retries transient HTTP failures (5xx, 429, network errors); each attempt
// re-opens destPath with mode "w" (truncates) so a half-written file from a
// failed attempt doesn't survive.

import * as fs from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { withRetry } from "../retry/retry.js";
import { TransportError } from "./errors.js";

export interface DownloadOptions {
  /** Override fetch for tests. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Maximum attempt count (including the first). Defaults to 3. */
  maxAttempts?: number;
  /** Base delay in ms; doubles each retry. Defaults to 500. Tests pass 1 to skip wall-clock sleeps. */
  baseDelayMs?: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 500;

async function failFromResponse(resp: Response): Promise<never> {
  const snippet = await resp.text().catch(() => "");
  const message = `download: GET failed ${resp.status} ${resp.statusText}: ${snippet.slice(0, 200)}`;
  const retryable = resp.status >= 500 || resp.status === 429;
  throw new TransportError(message, resp.status, retryable);
}

/** Streams a GET response body to `destPath`. Throws TransportError on non-2xx. */
export async function downloadToFile(
  url: string,
  destPath: string,
  opts: DownloadOptions = {},
): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const retry = {
    maxAttempts: opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    baseDelayMs: opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
    isRetryable: (err: unknown) =>
      err instanceof TransportError && err.retryable,
  };

  await withRetry(async () => {
    let resp: Response;
    try {
      resp = await fetchImpl(url);
    } catch (err) {
      throw new TransportError(
        `download: network error: ${(err as Error).message}`,
        0,
        true,
      );
    }
    if (!resp.ok) await failFromResponse(resp);
    if (!resp.body) {
      throw new TransportError("download: response has no body", resp.status, false);
    }

    // fs.open(destPath, "w") truncates any partial file from a previous
    // attempt before this attempt writes.
    const sink = await fs.open(destPath, "w");
    try {
      // lib.dom's ReadableStream and node:stream/web's ReadableStream are the
      // same runtime object but typed differently (BYOB reader signatures
      // diverge). Cast to the node:stream/web variant that fromWeb expects.
      const stream = Readable.fromWeb(
        resp.body as unknown as NodeWebReadableStream<Uint8Array>,
      );
      await pipeline(stream, sink.createWriteStream());
    } finally {
      await sink.close().catch(() => {});
    }
  }, retry);
}
