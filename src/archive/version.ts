// Cache version derivation. MUST match
// @actions/cache/src/internal/cacheUtils.ts::getCacheVersion so a workflow
// migrating between actions/cache@v5 and buildrush/cache@v6 sees the same
// cache hierarchy.

import * as crypto from "node:crypto";

const VERSION_SALT = "1.0";

// "zstd" | "zstd-no-long" | "gzip" mirror upstream's getCacheVersion values.
// "none" is a Build_Rush-specific extension (no upstream equivalent), used only
// within the BR cache namespace for the uncompressed tier.
export type CompressionMethod = "zstd" | "zstd-no-long" | "gzip" | "none";

export function computeCacheVersion(
  paths: string[],
  compressionMethod: CompressionMethod | undefined,
  enableCrossOsArchive: boolean,
  platform: NodeJS.Platform = process.platform,
): string {
  const components = paths.slice();
  if (compressionMethod) {
    components.push(compressionMethod);
  }
  if (platform === "win32" && !enableCrossOsArchive) {
    components.push("windows-only");
  }
  components.push(VERSION_SALT);
  return crypto.createHash("sha256").update(components.join("|")).digest("hex");
}
