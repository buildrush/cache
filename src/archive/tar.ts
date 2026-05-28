// Thin wrappers around the `tar` v7 package. Used by the save pipeline
// (tar create -> zstd compress -> upload) and the restore pipeline
// (download -> zstd decompress -> tar extract).

import { Readable } from "node:stream";
import { c, x } from "tar";

/**
 * Returns a Readable stream of tar bytes packing the given `paths`
 * (relative to `cwd`). Wraps tar v7's Pack (a Minipass-based AsyncIterable)
 * in a real node:stream Readable so it composes cleanly with downstream
 * pipes like the zstd compressor.
 */
export function createTarStream(paths: string[], cwd: string): Readable {
  if (paths.length === 0) {
    // tar v7 throws or hangs on an empty entry list depending on flow.
    // Surface a clear error from our boundary instead.
    throw new Error("createTarStream: paths must not be empty");
  }
  // Omitting `file:` selects the AsyncNoFile overload, which returns a Pack
  // (Minipass<Buffer>). Pack implements AsyncIterable<Buffer>, so
  // Readable.from(...) produces a fully-typed node:stream Readable.
  const pack = c({ cwd, portable: true, preservePaths: true }, paths);
  return Readable.from(pack);
}

/** Extracts a tar archive at `archivePath` into `destDir`. */
export async function extractTarStream(
  archivePath: string,
  destDir: string,
): Promise<void> {
  // Passing `file:` selects the AsyncFile overload, which returns Promise<void>.
  await x({ file: archivePath, cwd: destDir, preservePaths: true });
}
