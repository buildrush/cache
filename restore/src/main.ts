import * as core from "@actions/core";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import { mintAndExchange } from "../../src/auth/exchange.js";
import type { MintAndExchangeOptions } from "../../src/auth/exchange.js";
import type { RestoreOutcome } from "../../src/types.js";
import { ANNOTATION_PREFIX, applyFallback } from "../../src/auth/fallback.js";
import { ExchangeError, isFallbackMode } from "../../src/auth/types.js";
import {
  CacheClient,
  CacheClientError,
  type LookupHit,
} from "../../src/client/cacheClient.js";
import { computeCacheVersion } from "../../src/archive/version.js";
import {
  DEFAULT_COMPRESSION,
  isCompression,
  resolveCompression,
} from "../../src/archive/compression.js";
import { extractTarStream } from "../../src/archive/tar.js";
import { downloadToFile } from "../../src/transport/download.js";
import {
  formatBytes,
  formatDuration,
  formatSpeed,
  shortVersion,
} from "../../src/log/format.js";
import { Timer } from "../../src/log/timer.js";
import { debug, resolveVerbose, setVerbose } from "../../src/log/logger.js";
import { STATE_CACHE_MATCHED_KEY } from "../../src/state.js";

const SUCCESS_NOTICE = "Build_Rush cache authenticated";
const DEFAULT_BASE_URL = "https://cache.buildrush.io";

export async function run(): Promise<void> {
  // Resolve verbose first so every debug() below honors it.
  setVerbose(resolveVerbose());

  // Echo cache-primary-key first so it's set even when later input validation
  // fails — preserves drop-in parity with actions/cache/restore@v5 consumers
  // that read the output after the step fails.
  const primaryKey = core.getInput("key");
  core.setOutput("cache-primary-key", primaryKey);

  const fallbackInput = core.getInput("fallback") || "github";
  if (!isFallbackMode(fallbackInput)) {
    core.setFailed(
      `Invalid fallback value: '${fallbackInput}'. Must be github | skip | fail.`,
    );
    return;
  }

  const paths = core.getMultilineInput("path");
  const restoreKeys = core.getMultilineInput("restore-keys");
  const enableCrossOsArchive = core.getBooleanInput("enableCrossOsArchive");
  const lookupOnly = core.getBooleanInput("lookup-only");
  const failOnCacheMiss = core.getBooleanInput("fail-on-cache-miss");
  // action.yml's `audience` input has a default of "https://cache.buildrush.io",
  // so core.getInput("audience") is always non-empty in normal runs.
  const audience = core.getInput("audience");

  // Build_Rush-specific: resolve + validate the compression tier (fail fast,
  // before auth/network — same pattern as the fallback input above).
  const compressionInput = core.getInput("compression") || DEFAULT_COMPRESSION;
  if (!isCompression(compressionInput)) {
    core.setFailed(
      `Invalid compression value: '${compressionInput}'. Must be zstd-fast | zstd | none.`,
    );
    return;
  }
  const compression = resolveCompression(compressionInput);

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
    core.setOutput("cache-hit", "false");
    core.setOutput("cache-matched-key", "");
    return;
  }

  // 2. Lookup against the Build_Rush cache service.
  const baseUrl = process.env.BUILDRUSH_CACHE_URL || DEFAULT_BASE_URL;
  const client = new CacheClient(baseUrl, token);
  const version = computeCacheVersion(paths, compression.versionMethod, enableCrossOsArchive);
  core.info(`Cache version: ${shortVersion(version)}`);

  debug(
    `lookup: key=${primaryKey} version=${shortVersion(version)} restore-keys=[${restoreKeys.join(", ")}]`,
  );
  let hit: LookupHit | null;
  try {
    hit = await client.lookupEntry({
      key: primaryKey,
      version,
      restoreKeys,
    });
  } catch (err) {
    const msg =
      err instanceof CacheClientError
        ? err.message
        : (err as Error).message;
    core.warning(`Cache lookup failed: ${msg}`);
    core.setOutput("cache-hit", "false");
    core.setOutput("cache-matched-key", "");
    if (failOnCacheMiss) {
      core.setFailed(`Failed to restore cache entry — lookup error: ${msg}`);
    }
    return;
  }

  if (!hit) {
    core.info(
      `Cache not found for input keys: ${[primaryKey, ...restoreKeys].join(", ")}`,
    );
    core.setOutput("cache-hit", "false");
    core.setOutput("cache-matched-key", "");
    if (failOnCacheMiss) {
      core.setFailed(
        `Failed to restore cache entry — no key found for ${primaryKey}`,
      );
    }
    return;
  }

  core.setOutput("cache-matched-key", hit.matchedKey);
  core.setOutput("cache-hit", String(hit.matchedKey === primaryKey));
  // Record the matched key for the save post-action: when it equals the
  // primary key (an exact hit) save skips re-uploading; a prefix / restore-key
  // hit records a differing key, so the save still runs (actions/cache@v5
  // parity). Set before the lookup-only early return so the skip applies there
  // too.
  core.saveState(STATE_CACHE_MATCHED_KEY, hit.matchedKey);
  core.info(`Cache restored from key: ${hit.matchedKey}`);

  if (lookupOnly) return;

  // 3. Download + decompress + extract.
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "br-restore-"));
  const archivePath = path.join(tmpDir, "cache.tar.zst");
  const tarPath = path.join(tmpDir, "cache.tar");

  // F1b telemetry: capture client-observed signals across every exit path.
  // outcome starts pessimistic and is upgraded only as each phase completes.
  let outcome: RestoreOutcome = "download_failed";
  let clientDurationMs: number | null = null;
  let clientBytes: number | null = null;
  let clientThroughput: number | null = null;
  let decompressMs: number | null = null;

  try {
    const downloadTimer = new Timer();
    await downloadToFile(hit.downloadUrl, archivePath);
    clientDurationMs = downloadTimer.elapsedMs();
    clientBytes = (await fs.stat(archivePath)).size;
    clientThroughput =
      clientDurationMs > 0 ? clientBytes / (clientDurationMs / 1000) : null;
    const speed = formatSpeed(clientBytes, clientDurationMs);
    const tail = speed === "" ? "" : ` (${speed})`;
    core.info(
      `Downloaded ${formatBytes(clientBytes)} in ${formatDuration(clientDurationMs)}${tail}`,
    );

    // Download succeeded — any failure beyond here is an extract failure.
    outcome = "extract_failed";

    const extractTimer = new Timer();
    // Decompress the downloaded archive to a plain tar, then extract.
    await using inHandle = await fs.open(archivePath, "r");
    await using outHandle = await fs.open(tarPath, "w");
    await pipeline(
      inHandle.createReadStream(),
      compression.makeDecompress(),
      outHandle.createWriteStream(),
    );

    await extractTarStream(tarPath, process.cwd());
    decompressMs = extractTimer.elapsedMs(); // decompress+extract combined (design §5)
    outcome = "ok";
    core.info(`Extracted in ${formatDuration(decompressMs)}`);
    core.info("Cache restored successfully");
  } catch (err) {
    core.warning(
      `Cache restore download/extract failed: ${(err as Error).message}`,
    );
    if (failOnCacheMiss) {
      core.setFailed(
        `Failed to restore cache entry: ${(err as Error).message}`,
      );
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
    // F1b: best-effort telemetry — must never throw into the cache step.
    try {
      await client.reportTelemetry({
        key: primaryKey,
        version,
        matchedKey: hit.matchedKey,
        // Durations cross the wire as integer milliseconds (cache_event_log
        // BIGINT / Go *int64). Timer.elapsedMs() is a sub-millisecond float, so
        // round before sending — the service's strict JSON decoder rejects a
        // fractional number into int64 with a 400, which this best-effort path
        // would silently swallow (no telemetry row would persist).
        clientDurationMs:
          clientDurationMs === null ? null : Math.round(clientDurationMs),
        clientBytes,
        clientThroughput,
        decompressMs: decompressMs === null ? null : Math.round(decompressMs),
        outcome,
      });
      debug(`telemetry: reported outcome=${outcome}`);
    } catch (err) {
      debug(`telemetry: post failed (ignored): ${(err as Error).message}`);
    }
  }
}
