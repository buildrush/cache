// HTTP PUT helpers for cache uploads. The cache service hands out either a
// signed PUT URL (single-shot, ≤128 MiB) or a GCS resumable session URI
// (chunked PUT loop with Content-Range, sequential within the session).
//
// Bodies stream from disk via fs.createReadStream + Readable.toWeb so the
// archive is never materialised into a Buffer.

import * as fs from "node:fs";
import { Readable } from "node:stream";
import { TransportError } from "./errors.js";
import { withRetry } from "../retry/retry.js";

export interface UploadOptions {
  /** Override fetch for tests. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Maximum attempt count (including the first). Defaults to 3. */
  maxAttempts?: number;
  /** Base delay in ms; doubles each retry. Defaults to 500. Tests pass 1 to skip wall-clock sleeps. */
  baseDelayMs?: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 500;

function retryOpts(opts: UploadOptions): {
  maxAttempts: number;
  baseDelayMs: number;
  isRetryable: (err: unknown) => boolean;
} {
  return {
    maxAttempts: opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    baseDelayMs: opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
    isRetryable: (err) => err instanceof TransportError && err.retryable,
  };
}

/**
 * Choose upload transport based on the URL shape returned by the cache
 * service. GCS resumable session URIs always carry `upload_id=` in the
 * query string; signed PUT URLs never do. Fall back to single-shot for
 * anything we can't positively identify as a resumable session — that
 * is the safer default (works against any signed URL), and chunked PUTs
 * against a non-session URL would be rejected as invalid Content-Range
 * against a one-shot endpoint.
 */
export function chooseUploadMode(
  uploadUrl: string,
): "single-shot" | "chunked" {
  return /[?&]upload_id=/.test(uploadUrl) ? "chunked" : "single-shot";
}

async function fail(resp: Response, prefix: string): Promise<never> {
  const snippet = await resp.text().catch(() => "");
  const message = `${prefix} ${resp.status} ${resp.statusText}: ${snippet.slice(0, 200)}`;
  const retryable = resp.status >= 500 || resp.status === 429;
  throw new TransportError(message, resp.status, retryable);
}

/**
 * Stream a Node Readable into a WHATWG ReadableStream that fetch accepts.
 * lib.dom's BodyInit types don't accept node:stream/web's ReadableStream
 * directly because the BYOB reader signatures diverge — cast through the
 * lib.dom variant. The runtime object is identical.
 */
function toFetchBody(stream: fs.ReadStream): ReadableStream<Uint8Array> {
  return Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
}

/** Single-shot PUT streaming `sourcePath` to `url`. Retries transient failures. */
export async function putSingleShot(
  url: string,
  sourcePath: string,
  sizeBytes: number,
  opts: UploadOptions = {},
): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  await withRetry(async () => {
    const stream = fs.createReadStream(sourcePath);
    let resp: Response;
    try {
      resp = await fetchImpl(url, {
        method: "PUT",
        headers: { "Content-Length": String(sizeBytes) },
        body: toFetchBody(stream),
        // Node's fetch requires duplex: "half" when body is a stream. lib.dom
        // doesn't declare this field yet, hence the cast.
        duplex: "half",
      } as RequestInit);
    } catch (err) {
      stream.destroy();
      throw new TransportError(
        `upload: network error: ${(err as Error).message}`,
        0,
        true,
      );
    }
    if (resp.status < 200 || resp.status >= 300) await fail(resp, "upload: PUT failed");
  }, retryOpts(opts));
}

/**
 * Chunked PUT loop against a GCS resumable session URI. Non-final chunks
 * expect 308 with a Range header whose upper bound matches the chunk's end
 * byte; the final chunk expects 200 or 201. Sequential — GCS does not accept
 * parallel uploads within a single session.
 *
 * Each chunk streams from disk via fs.createReadStream({ start, end }) so the
 * archive is never fully materialised in memory.
 */
export async function putChunked(
  sessionUrl: string,
  sourcePath: string,
  sizeBytes: number,
  chunkSize: number,
  opts: UploadOptions = {},
): Promise<void> {
  if (chunkSize <= 0) throw new Error("putChunked: chunkSize must be > 0");
  if (sizeBytes <= 0) throw new Error("putChunked: sizeBytes must be > 0");
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const retry = retryOpts(opts);

  for (let offset = 0; offset < sizeBytes; offset += chunkSize) {
    const end = Math.min(offset + chunkSize, sizeBytes) - 1;
    const isFinal = end === sizeBytes - 1;
    await withRetry(async () => {
      // Re-create the stream every attempt so retries always start at the
      // chunk's own offset — no resumable-session state across attempts.
      const chunkStream = fs.createReadStream(sourcePath, { start: offset, end });
      let resp: Response;
      try {
        resp = await fetchImpl(sessionUrl, {
          method: "PUT",
          headers: {
            "Content-Length": String(end - offset + 1),
            "Content-Range": `bytes ${offset}-${end}/${sizeBytes}`,
          },
          body: toFetchBody(chunkStream),
          duplex: "half",
        } as RequestInit);
      } catch (err) {
        chunkStream.destroy();
        throw new TransportError(
          `upload: network error on chunk ${offset}-${end}/${sizeBytes}: ${(err as Error).message}`,
          0,
          true,
        );
      }

      if (isFinal) {
        if (resp.status !== 200 && resp.status !== 201) {
          await fail(resp, "upload: final PUT failed");
        }
      } else if (resp.status !== 308) {
        await fail(resp, `upload: chunk PUT failed at bytes ${offset}-${end}/${sizeBytes}:`);
      } else {
        assertChunkFullyPersisted(resp, offset, end, sizeBytes);
      }
    }, retry);
  }
}

function assertChunkFullyPersisted(
  resp: Response,
  offset: number,
  end: number,
  total: number,
): void {
  const rangeHeader = resp.headers.get("Range");
  if (!rangeHeader) {
    throw new TransportError(
      `upload: chunk PUT at bytes ${offset}-${end}/${total} returned 308 with no Range header — GCS persisted 0 bytes`,
      308,
      true,
    );
  }
  const match = /^bytes=0-(\d+)$/.exec(rangeHeader);
  if (!match) {
    throw new TransportError(
      `upload: chunk PUT at bytes ${offset}-${end}/${total} returned 308 with unparseable Range header: ${rangeHeader}`,
      308,
      true,
    );
  }
  const persistedEnd = Number.parseInt(match[1]!, 10);
  if (persistedEnd !== end) {
    throw new TransportError(
      `upload: chunk PUT at bytes ${offset}-${end}/${total} only persisted bytes 0-${persistedEnd} — partial-persistence resume not supported`,
      308,
      true,
    );
  }
}
