// Maps the user-facing `compression` input to its cache-version method and the
// stream factories used by the save/restore pipelines. Keeps the two main.ts
// entry points free of zlib/level details (those live in ./compress.ts).
//
// `zstd-fast` and `zstd` both map to the "zstd" wire format (same decoder), so
// they share a cache-version namespace and interoperate within a key. `none`
// stores the raw tar and gets its own "none" namespace.

import type { Transform } from "node:stream";
import {
  compressStream,
  decompressStream,
  passthroughStream,
  ZSTD_FAST_LEVEL,
  ZSTD_LEVEL,
} from "./compress.js";
import type { CompressionMethod } from "./version.js";

/** User-facing `compression` input values. */
export type Compression = "zstd-fast" | "zstd" | "none";

/** Value used when the input is empty/unset. */
export const DEFAULT_COMPRESSION: Compression = "zstd-fast";

/** Type guard mirroring isFallbackMode — validates the raw input string. */
export function isCompression(value: string): value is Compression {
  return value === "zstd-fast" || value === "zstd" || value === "none";
}

export interface ResolvedCompression {
  /** Method string folded into computeCacheVersion (the cache namespace). */
  versionMethod: CompressionMethod;
  /** Encoder Transform for the save pipeline. */
  makeCompress(): Transform;
  /** Decoder Transform for the restore pipeline. */
  makeDecompress(): Transform;
}

export function resolveCompression(c: Compression): ResolvedCompression {
  switch (c) {
    case "none":
      return {
        versionMethod: "none",
        makeCompress: passthroughStream,
        makeDecompress: passthroughStream,
      };
    case "zstd":
      return {
        versionMethod: "zstd",
        makeCompress: () => compressStream(ZSTD_LEVEL),
        makeDecompress: decompressStream,
      };
    case "zstd-fast":
      return {
        versionMethod: "zstd",
        makeCompress: () => compressStream(ZSTD_FAST_LEVEL),
        makeDecompress: decompressStream,
      };
  }
}
