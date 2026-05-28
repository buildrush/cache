import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const home = "/home/runner";

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: vi.fn(() => home) };
});

const { expandHomeTilde, expandGlobs } = await import(
  "../../src/archive/paths.js"
);

// Use the real os module for tmpdir-based fixtures in expandGlobs tests
// since the module-level mock intercepts node:os.homedir but tmpdir delegates
// to the actual implementation via `actual`.
const realOs = await vi.importActual<typeof import("node:os")>("node:os");

describe("expandHomeTilde", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("expands `~/foo` to `<home>/foo`", () => {
    expect(expandHomeTilde(["~/foo"])).toEqual([path.join(home, "foo")]);
  });

  it("expands bare `~` to `<home>`", () => {
    expect(expandHomeTilde(["~"])).toEqual([home]);
  });

  it("expands nested `~/a/b/c` to `<home>/a/b/c`", () => {
    expect(expandHomeTilde(["~/a/b/c"])).toEqual([
      path.join(home, "a", "b", "c"),
    ]);
  });

  it("leaves absolute paths unchanged", () => {
    expect(expandHomeTilde(["/tmp/cache"])).toEqual(["/tmp/cache"]);
  });

  it("leaves relative paths unchanged", () => {
    expect(expandHomeTilde(["build/out"])).toEqual(["build/out"]);
  });

  it("leaves `~otheruser` unchanged (no passwd lookup)", () => {
    expect(expandHomeTilde(["~root/x"])).toEqual(["~root/x"]);
  });

  it("expands per-entry, mixing forms", () => {
    expect(
      expandHomeTilde(["~/.cache/go-build", "~/go/pkg/mod", "/abs/path"]),
    ).toEqual([
      path.join(home, ".cache/go-build"),
      path.join(home, "go/pkg/mod"),
      "/abs/path",
    ]);
  });

  it("returns an empty array for an empty input", () => {
    expect(expandHomeTilde([])).toEqual([]);
  });

  // Windows backslash form. actions/cache@v5 accepts `~\foo` in path: inputs
  // and expands the tilde regardless of the trailing separator; node-tar on a
  // Windows runner sees the literal `~` directory under the workspace and
  // fails with ENOENT. The fix handles both `~/...` and `~\...`.
  it("expands `~\\foo` to `<home>/foo` (Windows backslash)", () => {
    expect(expandHomeTilde(["~\\foo"])).toEqual([path.join(home, "foo")]);
  });

  it("expands `~\\AppData\\Local\\deno` (Windows nested backslash)", () => {
    // node-tar accepts forward slashes on Windows; what matters is that the
    // leading `~\` is recognized and replaced with $HOME. The post-tilde
    // remainder is joined via path.join, which is platform-aware at runtime
    // (Windows path.join normalizes separators; POSIX path.join preserves
    // backslashes verbatim — both work for node-tar).
    expect(expandHomeTilde(["~\\AppData\\Local\\deno"])).toEqual([
      path.join(home, "AppData\\Local\\deno"),
    ]);
  });

  // `!`-prefixed exclusion entries. node-tar and the upstream actions/cache
  // globber both treat `!path` as an exclusion. The tilde inside an exclusion
  // must still be expanded, otherwise downstream pack/glob calls hit a literal
  // `!~/foo` directory.
  it("expands `!~/foo` to `!<home>/foo`", () => {
    expect(expandHomeTilde(["!~/foo"])).toEqual([
      "!" + path.join(home, "foo"),
    ]);
  });

  it("expands `!~\\foo` to `!<home>/foo` (exclusion + Windows backslash)", () => {
    expect(expandHomeTilde(["!~\\foo"])).toEqual([
      "!" + path.join(home, "foo"),
    ]);
  });

  it("expands `!~` (bare exclusion) to `!<home>`", () => {
    expect(expandHomeTilde(["!~"])).toEqual(["!" + home]);
  });

  it("preserves `!` on absolute exclusions", () => {
    expect(expandHomeTilde(["!/tmp/cache"])).toEqual(["!/tmp/cache"]);
  });

  it("expands mixed include/exclude entries per-entry", () => {
    expect(
      expandHomeTilde([
        "~/.nuget/packages",
        "!~/.nuget/packages/unwanted",
        "/abs/path",
      ]),
    ).toEqual([
      path.join(home, ".nuget/packages"),
      "!" + path.join(home, ".nuget/packages/unwanted"),
      "/abs/path",
    ]);
  });
});

describe("expandGlobs", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.realpath(
      await fs.mkdtemp(path.join(realOs.tmpdir(), "br-cache-glob-")),
    );
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns an empty array for empty input", async () => {
    expect(await expandGlobs([])).toEqual([]);
  });

  it("passes a concrete absolute file path through", async () => {
    const file = path.join(tmpDir, "concrete.txt");
    await fs.writeFile(file, "x");
    const result = await expandGlobs([file]);
    expect(result).toEqual([file]);
  });

  it("passes a concrete absolute directory path through (no implicit descendants)", async () => {
    // implicitDescendants: false means a literal dir match returns just the
    // dir itself; tar then walks descendants on its own. Without this guard
    // glob would emit `<dir>` plus every file under it as separate entries.
    const dir = path.join(tmpDir, "concrete-dir");
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "a"), "1");
    await fs.writeFile(path.join(dir, "b"), "2");
    const result = await expandGlobs([dir]);
    expect(result).toEqual([dir]);
  });

  it("expands `**/node_modules` to all matching dirs (the node-lerna recipe)", async () => {
    // Reproduces the actions/cache@v5 examples.md "node — lerna" snippet:
    //   path: '**/node_modules'
    // The compat workflow's node-lerna job seeds node_modules at root and
    // packages/a/. Without expansion, node-tar lstats `<workspace>/**/node_modules`
    // verbatim and ENOENTs (PR #11 production failure).
    await fs.mkdir(path.join(tmpDir, "node_modules"));
    await fs.mkdir(path.join(tmpDir, "packages", "a", "node_modules"), {
      recursive: true,
    });

    const result = await expandGlobs([
      path.join(tmpDir, "**", "node_modules"),
    ]);

    expect(result).toEqual(
      expect.arrayContaining([
        path.join(tmpDir, "node_modules"),
        path.join(tmpDir, "packages", "a", "node_modules"),
      ]),
    );
    expect(result).toHaveLength(2);
  });

  it("returns an empty array for a non-matching glob", async () => {
    // No `node_modules` ever created — pattern matches nothing. Glob returns
    // an empty list rather than throwing; the caller (createTarStream) will
    // raise the empty-include guard, surfacing a clear error.
    const result = await expandGlobs([
      path.join(tmpDir, "**", "does-not-exist"),
    ]);
    expect(result).toEqual([]);
  });

  it("expands multiple patterns and de-duplicates overlapping matches", async () => {
    // Two patterns that both match the same directory must not double-count.
    // glob.create with newline-separated patterns handles dedup internally.
    const dir = path.join(tmpDir, "shared");
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "stamp"), "x");

    const result = await expandGlobs([
      path.join(tmpDir, "shared"),
      path.join(tmpDir, "**", "shared"),
    ]);
    expect(result).toEqual([dir]);
  });
});
