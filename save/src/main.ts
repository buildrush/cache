import * as core from "@actions/core";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import { mintAndExchange } from "../../src/auth/exchange.js";
import type { MintAndExchangeOptions } from "../../src/auth/exchange.js";
import { ANNOTATION_PREFIX, applyFallback } from "../../src/auth/fallback.js";
import { ExchangeError, isFallbackMode } from "../../src/auth/types.js";
import {
  CacheClient,
  CacheClientError,
} from "../../src/client/cacheClient.js";
import { computeCacheVersion } from "../../src/archive/version.js";
import { compressStream } from "../../src/archive/compress.js";
import { expandHomeTilde } from "../../src/archive/paths.js";
import { createTarStream } from "../../src/archive/tar.js";
import { chooseUploadMode, putSingleShot, putChunked } from "../../src/transport/upload.js";
import { CountingPassThrough } from "../../src/archive/counting.js";
import {
  formatBytes,
  formatDuration,
  formatRatio,
  formatSpeed,
  shortVersion,
} from "../../src/log/format.js";
import { Timer } from "../../src/log/timer.js";

const SUCCESS_NOTICE = "Build_Rush cache authenticated";
const DEFAULT_BASE_URL = "https://cache.buildrush.io";

/** Default chunk size for the chunked PUT loop. */
const DEFAULT_CHUNK_SIZE = 32 * 1024 * 1024; // 32 MiB

/**
 * Parse the `upload-chunk-size` input. Falls back to DEFAULT_CHUNK_SIZE when
 * the input is empty or malformed — NaN / <=0 values would otherwise flow
 * into putChunked and produce invalid Content-Length / Content-Range
 * headers in an infinite loop.
 */
function resolveChunkSize(raw: string): number {
  if (!raw) return DEFAULT_CHUNK_SIZE;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CHUNK_SIZE;
}

export async function run(): Promise<void> {
  // Resolve + validate inputs first so we can fail fast on bad config.
  const fallbackInput = core.getInput("fallback") || "github";
  if (!isFallbackMode(fallbackInput)) {
    core.setFailed(
      `Invalid fallback value: '${fallbackInput}'. Must be github | skip | fail.`,
    );
    return;
  }

  const paths = core.getMultilineInput("path");
  const primaryKey = core.getInput("key");
  const enableCrossOsArchive = core.getBooleanInput("enableCrossOsArchive");
  const chunkSize = resolveChunkSize(core.getInput("upload-chunk-size"));
  // action.yml's `audience` input has a default of "https://cache.buildrush.io",
  // so core.getInput("audience") is always non-empty in normal runs.
  const audience = core.getInput("audience");

  // 1. Auth — mint + exchange OIDC for a cache-service token.
  let token: string;
  try {
    const opts: MintAndExchangeOptions = { audience };
    const exchangeBaseUrl = process.env.BUILDRUSH_CACHE_URL;
    if (exchangeBaseUrl) opts.exchangeBaseUrl = exchangeBaseUrl;
    const result = await mintAndExchange(opts);
    token = result.token;
    core.setOutput("buildrush-reason", "");
    core.notice(SUCCESS_NOTICE);
  } catch (err) {
    if (!(err instanceof ExchangeError)) {
      core.setOutput("buildrush-reason", "");
      core.setFailed(`Unexpected error: ${(err as Error).message}`);
      return;
    }
    core.setOutput("buildrush-reason", err.reason);
    const fb = applyFallback(fallbackInput, err.reason);
    if (fb.shouldFail) {
      core.setFailed(
        `${ANNOTATION_PREFIX} failing step (reason: ${err.reason})`,
      );
      return;
    }
    if (fb.disableCache) {
      core.exportVariable("ACTIONS_CACHE_DISABLED", "true");
    }
    return;
  }

  // 2. Archive — tar + zstd to a tempfile.
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "br-save-"));
  const archivePath = path.join(tmpDir, "cache.tar.zst");
  let counter: CountingPassThrough | undefined;
  try {
    const outHandle = await fs.open(archivePath, "w");
    try {
      // Expand `~` so node-tar can find the source dirs. `paths` itself
      // stays literal so computeCacheVersion's digest remains stable
      // across runners (see src/archive/version.ts header comment).
      counter = new CountingPassThrough();
      await pipeline(
        createTarStream(expandHomeTilde(paths), process.cwd()),
        counter,
        compressStream(),
        outHandle.createWriteStream(),
      );
    } finally {
      await outHandle.close().catch(() => undefined);
    }

    const stat = await fs.stat(archivePath);
    const sizeBytes = stat.size;

    // 3. Reserve an entry against the cache service.
    const baseUrl = process.env.BUILDRUSH_CACHE_URL || DEFAULT_BASE_URL;
    const client = new CacheClient(baseUrl, token);
    const version = computeCacheVersion(paths, "zstd", enableCrossOsArchive);
    core.info(`Cache version: ${shortVersion(version)}`);

    core.info(`Reserving cache for key: ${primaryKey}`);
    let uploadUrl: string;
    try {
      uploadUrl = await client.createEntry({
        key: primaryKey,
        version,
        sizeBytes,
      });
    } catch (err) {
      if (
        err instanceof CacheClientError &&
        err.code === "ALREADY_EXISTS"
      ) {
        core.info(
          `Cache entry for key ${primaryKey} already exists; skipping upload.`,
        );
        return;
      }
      const msg =
        err instanceof CacheClientError
          ? err.message
          : (err as Error).message;
      core.warning(`Failed to reserve cache entry: ${msg}`);
      return;
    }

    const uncompressedBytes = counter?.bytes ?? 0;
    const ratio = formatRatio(uncompressedBytes, sizeBytes);
    const ratioTail = ratio === "" ? "" : `, ${ratio}`;
    core.info(
      `Cache size: ${formatBytes(sizeBytes)} compressed (${formatBytes(uncompressedBytes)} uncompressed${ratioTail})`,
    );

    // 4. Upload the archive — streamed from disk to keep memory bounded.
    // Transport is selected by URL shape returned by the cache service: a
    // GCS resumable session URI (upload_id=...) uses chunked PUT; a signed
    // PUT URL uses single-shot. See chooseUploadMode for details.
    try {
      const uploadTimer = new Timer();
      if (chooseUploadMode(uploadUrl) === "chunked") {
        await putChunked(uploadUrl, archivePath, sizeBytes, chunkSize);
      } else {
        await putSingleShot(uploadUrl, archivePath, sizeBytes);
      }
      const uploadMs = uploadTimer.elapsedMs();
      const speed = formatSpeed(sizeBytes, uploadMs);
      const uploadTail = speed === "" ? "" : ` (${speed})`;
      core.info(
        `Uploaded ${formatBytes(sizeBytes)} in ${formatDuration(uploadMs)}${uploadTail}`,
      );
    } catch (err) {
      core.warning(`Failed to upload cache: ${(err as Error).message}`);
      return;
    }

    // 5. Finalize the entry so it becomes visible to lookups.
    try {
      await client.finalizeEntry({
        key: primaryKey,
        version,
        sizeBytes,
      });
      core.info(`Cache saved successfully (key: ${primaryKey})`);
    } catch (err) {
      const msg =
        err instanceof CacheClientError
          ? err.message
          : (err as Error).message;
      core.warning(`Failed to finalize cache: ${msg}`);
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}
