// zstd compression via Node 24's node:zlib built-ins. Used by the save
// pipeline (tar -> compress -> upload) and the restore pipeline (download
// -> decompress -> tar extract).
//
// These return raw Transform streams (no input piping) so callers slot
// them into a `node:stream/promises` `pipeline()` as middle stages —
// `pipeline` then propagates errors from upstream sources (tar/file
// reads) instead of swallowing them on the destination's `.on("error")`.

import { createZstdCompress, createZstdDecompress } from "node:zlib";
import type { Transform } from "node:stream";

/** Returns a Transform that emits zstd-compressed bytes from its input. */
export function compressStream(): Transform {
  return createZstdCompress();
}

/** Returns a Transform that emits decompressed bytes from a zstd-compressed input. */
export function decompressStream(): Transform {
  return createZstdDecompress();
}
