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
  type LookupHit,
} from "../../src/client/cacheClient.js";
import { computeCacheVersion } from "../../src/archive/version.js";
import { decompressStream } from "../../src/archive/compress.js";
import { extractTarStream } from "../../src/archive/tar.js";
import { downloadToFile } from "../../src/transport/download.js";
import {
  formatBytes,
  formatDuration,
  formatSpeed,
  shortVersion,
} from "../../src/log/format.js";
import { Timer } from "../../src/log/timer.js";

const SUCCESS_NOTICE = "Build_Rush cache authenticated";
const DEFAULT_BASE_URL = "https://cache.buildrush.io";

export async function run(): Promise<void> {
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
  const version = computeCacheVersion(paths, "zstd", enableCrossOsArchive);
  core.info(`Cache version: ${shortVersion(version)}`);

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
  core.info(`Cache restored from key: ${hit.matchedKey}`);

  if (lookupOnly) return;

  // 3. Download + decompress + extract.
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "br-restore-"));
  const archivePath = path.join(tmpDir, "cache.tar.zst");
  const tarPath = path.join(tmpDir, "cache.tar");
  try {
    const downloadTimer = new Timer();
    await downloadToFile(hit.downloadUrl, archivePath);
    const downloadMs = downloadTimer.elapsedMs();
    const downloadedBytes = (await fs.stat(archivePath)).size;
    const speed = formatSpeed(downloadedBytes, downloadMs);
    const tail = speed === "" ? "" : ` (${speed})`;
    core.info(
      `Downloaded ${formatBytes(downloadedBytes)} in ${formatDuration(downloadMs)}${tail}`,
    );

    const extractTimer = new Timer();
    // Decompress the downloaded archive to a plain tar, then extract.
    // `await using` makes the file handles leak-proof against any exception
    // between the two opens or during pipeline().
    await using inHandle = await fs.open(archivePath, "r");
    await using outHandle = await fs.open(tarPath, "w");
    await pipeline(
      inHandle.createReadStream(),
      decompressStream(),
      outHandle.createWriteStream(),
    );

    await extractTarStream(tarPath, process.cwd());
    core.info(`Extracted in ${formatDuration(extractTimer.elapsedMs())}`);
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
  }
}
