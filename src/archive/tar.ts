// Thin wrappers around the `tar` v7 package. Used by the save pipeline
// (tar create -> zstd compress -> upload) and the restore pipeline
// (download -> zstd decompress -> tar extract).

import * as path from "node:path";
import { Readable } from "node:stream";
import { c, x } from "tar";

/**
 * Returns a Readable stream of tar bytes packing the given `paths`
 * (relative to `cwd`). Wraps tar v7's Pack (a Minipass-based AsyncIterable)
 * in a real node:stream Readable so it composes cleanly with downstream
 * pipes like the zstd compressor.
 *
 * Entries prefixed with `!` are treated as exclusion patterns (matching the
 * actions/cache examples.md "with exclusions" semantics handled upstream by
 * @actions/glob). They are stripped from the include list passed to `tar.c`
 * — otherwise node-tar lstat()s `<cwd>/!<entry>` and ENOENTs — and converted
 * into a `filter` callback that drops any include-side path resolving under
 * an excluded absolute root.
 */
export function createTarStream(paths: string[], cwd: string): Readable {
  const includes: string[] = [];
  const excludeRoots: string[] = [];
  for (const entry of paths) {
    if (entry.startsWith("!")) {
      excludeRoots.push(path.resolve(cwd, entry.slice(1)));
    } else {
      includes.push(entry);
    }
  }
  if (includes.length === 0) {
    // tar v7 throws or hangs on an empty entry list depending on flow.
    // Surface a clear error from our boundary instead.
    throw new Error("createTarStream: paths must not be empty");
  }
  // tar's `filter(p, stat)` is called per walked entry — `p` is the path as
  // emitted to the archive (resolved against `cwd` by tar). Return false to
  // drop the entry and skip its subtree.
  const filter = excludeRoots.length === 0
    ? undefined
    : (p: string): boolean => {
        const abs = path.resolve(cwd, p);
        return !excludeRoots.some(
          (root) => abs === root || abs.startsWith(root + path.sep),
        );
      };
  // Omitting `file:` selects the AsyncNoFile overload, which returns a Pack
  // (Minipass<Buffer>). Pack implements AsyncIterable<Buffer>, so
  // Readable.from(...) produces a fully-typed node:stream Readable.
  const pack = c(
    { cwd, portable: true, preservePaths: true, ...(filter && { filter }) },
    includes,
  );
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
