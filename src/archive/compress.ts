// zstd compression via Node 24's node:zlib built-ins, plus an identity
// passthrough for the uncompressed (`none`) tier. Used by the save pipeline
// (tar -> compress -> upload) and the restore pipeline (download ->
// decompress -> tar extract).
//
// These return raw Transform streams (no input piping) so callers slot them
// into a `node:stream/promises` `pipeline()` as middle stages — `pipeline`
// then propagates errors from upstream sources (tar/file reads) instead of
// swallowing them on the destination's `.on("error")`.

import { createZstdCompress, createZstdDecompress, constants } from "node:zlib";
import { PassThrough, type Transform } from "node:stream";

/** zstd level for the balanced `zstd` tier (matches the historic default). */
export const ZSTD_LEVEL = 3;
/** zstd level for the `zstd-fast` tier — equivalent to zstd `--fast=4`. */
export const ZSTD_FAST_LEVEL = -4;

/** Returns a Transform that emits zstd-compressed bytes at `level`. */
export function compressStream(level: number = ZSTD_LEVEL): Transform {
  return createZstdCompress({
    params: { [constants.ZSTD_c_compressionLevel]: level },
  });
}

/** Returns a Transform that emits decompressed bytes from a zstd-compressed input. */
export function decompressStream(): Transform {
  return createZstdDecompress();
}

/** Returns an identity Transform — used by the `none` (uncompressed) tier. */
export function passthroughStream(): Transform {
  return new PassThrough();
}
