import * as glob from "@actions/glob";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Expand a leading `~` in each path to `os.homedir()`. Action inputs come
 * in as raw YAML strings, so the shell never runs and `~` reaches node-tar
 * verbatim — node-tar then treats it as a literal directory name relative
 * to the workspace and the pack step fails with ENOENT on `<workspace>/~`.
 * actions/cache hides this via @actions/glob's implicit tilde resolution;
 * we don't use globber, so we do it here.
 *
 * Handles:
 *   - `~`              → `<home>`
 *   - `~/foo`          → `<home>/foo`
 *   - `~\foo`          → `<home>/foo` (Windows backslash form — actions/cache
 *                       accepts this verbatim in path: inputs)
 *   - `!~/foo` / `!~\foo` — `!`-prefixed exclusion entries: strip the `!`,
 *                       expand the tilde on the remainder, re-add the `!`.
 *                       Without this, downstream pack/glob hits a literal
 *                       `!~/foo` directory under the workspace.
 *   - `~otheruser` is left as-is because resolving it requires a passwd
 *     lookup we don't perform.
 */
export function expandHomeTilde(paths: string[]): string[] {
  const home = os.homedir();
  return paths.map((p) => {
    // Strip a leading `!` exclusion marker so the same tilde rules apply
    // to both include and exclude entries. The marker is re-added on emit.
    let prefix = "";
    let entry = p;
    if (entry.startsWith("!")) {
      prefix = "!";
      entry = entry.slice(1);
    }

    if (entry === "~") return prefix + home;
    // `~/` or `~\` — handle both POSIX and Windows separators after the
    // tilde so backslash-style paths from Windows YAML inputs expand too.
    if (entry.startsWith("~/") || entry.startsWith("~\\")) {
      return prefix + path.join(home, entry.slice(2));
    }
    return prefix + entry;
  });
}

/**
 * Enumerate the concrete filesystem paths matched by each entry. Action
 * inputs accept glob patterns like `**\/node_modules` (per actions/cache@v5
 * examples.md "node — lerna" recipe); without expansion node-tar lstats the
 * literal glob string under the workspace and ENOENTs.
 *
 * Inputs are assumed already tilde-expanded and split by `!` (callers handle
 * the include / exclude split — this helper enumerates either list of plain
 * positive patterns). Concrete paths pass through unchanged.
 *
 * Implementation notes:
 *   - `implicitDescendants: false` — match only what the caller specified.
 *     Let node-tar walk descendants of matched directories, the same way it
 *     does for concrete-path includes. Without this, `path: foo` would emit
 *     `foo` plus every file under `foo` as separate entries to tar.
 *   - `matchDirectories: true` — directories matching the pattern must be
 *     in the result set; tar then archives their contents.
 *   - `followSymbolicLinks: false` — preserve symlinks in the archive
 *     instead of dereferencing them at pack time.
 */
export async function expandGlobs(patterns: string[]): Promise<string[]> {
  if (patterns.length === 0) return [];
  const globber = await glob.create(patterns.join("\n"), {
    followSymbolicLinks: false,
    implicitDescendants: false,
    matchDirectories: true,
  });
  return globber.glob();
}
