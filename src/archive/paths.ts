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
 * Only `~` and `~/...` are handled — `~otheruser` is left as-is because
 * resolving it requires a passwd lookup we don't perform.
 */
export function expandHomeTilde(paths: string[]): string[] {
  const home = os.homedir();
  return paths.map((p) => {
    if (p === "~") return home;
    if (p.startsWith("~/")) return path.join(home, p.slice(2));
    return p;
  });
}
