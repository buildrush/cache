import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { Readable } from "node:stream";
import { expandGlobs } from "../../src/archive/paths.js";
import {
  createTarStream,
  extractTarStream,
} from "../../src/archive/tar.js";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "br-tar-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function streamToBuffer(s: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of s) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

describe("createTarStream / extractTarStream", () => {
  it("round-trips a small file tree", async () => {
    const src = path.join(dir, "src");
    await fs.mkdir(src);
    await fs.writeFile(path.join(src, "a.txt"), "hello a");
    await fs.writeFile(path.join(src, "b.txt"), "hello b");

    const stream = createTarStream(["src"], dir);
    const archive = path.join(dir, "out.tar");
    await fs.writeFile(archive, await streamToBuffer(stream));

    const dst = path.join(dir, "dst");
    await fs.mkdir(dst);
    await extractTarStream(archive, dst);

    expect(await fs.readFile(path.join(dst, "src/a.txt"), "utf8")).toBe(
      "hello a",
    );
    expect(await fs.readFile(path.join(dst, "src/b.txt"), "utf8")).toBe(
      "hello b",
    );
  });

  it("preserves file contents byte-for-byte (binary payload)", async () => {
    const src = path.join(dir, "src");
    await fs.mkdir(src);
    const payload = Buffer.alloc(8192);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 37) & 0xff;
    await fs.writeFile(path.join(src, "bin.dat"), payload);

    const archive = path.join(dir, "out.tar");
    await fs.writeFile(archive, await streamToBuffer(createTarStream(["src"], dir)));

    const dst = path.join(dir, "dst");
    await fs.mkdir(dst);
    await extractTarStream(archive, dst);

    const restored = await fs.readFile(path.join(dst, "src/bin.dat"));
    expect(restored.equals(payload)).toBe(true);
  });

  it("preserves nested directory structure", async () => {
    const root = path.join(dir, "root");
    await fs.mkdir(path.join(root, "a", "b", "c"), { recursive: true });
    await fs.writeFile(path.join(root, "top.txt"), "top");
    await fs.writeFile(path.join(root, "a", "mid.txt"), "mid");
    await fs.writeFile(path.join(root, "a", "b", "c", "deep.txt"), "deep");

    const archive = path.join(dir, "out.tar");
    await fs.writeFile(archive, await streamToBuffer(createTarStream(["root"], dir)));

    const dst = path.join(dir, "dst");
    await fs.mkdir(dst);
    await extractTarStream(archive, dst);

    expect(await fs.readFile(path.join(dst, "root/top.txt"), "utf8")).toBe("top");
    expect(await fs.readFile(path.join(dst, "root/a/mid.txt"), "utf8")).toBe("mid");
    expect(
      await fs.readFile(path.join(dst, "root/a/b/c/deep.txt"), "utf8"),
    ).toBe("deep");
  });

  it("throws synchronously on empty path list", () => {
    expect(() => createTarStream([], dir)).toThrow(/must not be empty/);
  });

  it("round-trips an absolute path into its original absolute location", async () => {
    const absSrc = path.join(dir, "abs-src");
    await fs.mkdir(absSrc);
    await fs.writeFile(path.join(absSrc, "stamp"), "marker");

    const archive = path.join(dir, "abs.tar");
    // paths[0] is absolute, cwd is unrelated to absSrc — this is the production
    // failure mode (workflow passes path: /tmp/foo with process.cwd() = workspace).
    await fs.writeFile(
      archive,
      await streamToBuffer(createTarStream([absSrc], dir)),
    );

    // Wipe the source and restore with cwd = unrelated location. Absolute paths
    // should reconstruct at their original absolute location regardless of cwd.
    await fs.rm(absSrc, { recursive: true, force: true });
    const unrelated = await fs.mkdtemp(path.join(os.tmpdir(), "br-tar-cwd-"));
    try {
      await extractTarStream(archive, unrelated);
      expect(await fs.readFile(path.join(absSrc, "stamp"), "utf8")).toBe("marker");
    } finally {
      await fs.rm(unrelated, { recursive: true, force: true });
    }
  });

  it("excludes !-prefixed entries from the archive (NuGet-style exclusion)", async () => {
    // Reproduces the actions/cache examples.md NuGet "with exclusions" snippet:
    //   path: |
    //     ~/.nuget/packages
    //     !~/.nuget/packages/unwanted
    // After expandHomeTilde the entries are absolute paths, with the `!`
    // prefix preserved on the exclusion. Without filter handling, node-tar
    // treats `!<absolute-path>` as a literal directory and ENOENTs on lstat.
    const root = path.join(dir, "packages");
    const wantedDir = path.join(root, "wanted");
    const unwantedDir = path.join(root, "unwanted");
    await fs.mkdir(wantedDir, { recursive: true });
    await fs.mkdir(unwantedDir, { recursive: true });
    await fs.writeFile(path.join(wantedDir, "kept.txt"), "kept");
    await fs.writeFile(path.join(unwantedDir, "excluded.txt"), "excluded");

    const archive = path.join(dir, "excl.tar");
    await fs.writeFile(
      archive,
      await streamToBuffer(
        createTarStream([root, `!${unwantedDir}`], dir),
      ),
    );

    // Extract into an unrelated cwd; absolute paths reconstruct at their
    // original location, just like the round-trip test above.
    const unrelated = await fs.mkdtemp(path.join(os.tmpdir(), "br-tar-cwd-"));
    try {
      // Wipe the source first so we can assert what was packed vs what was not.
      await fs.rm(root, { recursive: true, force: true });
      await extractTarStream(archive, unrelated);

      const keptPath = path.join(wantedDir, "kept.txt");
      const excludedPath = path.join(unwantedDir, "excluded.txt");
      expect(await fs.readFile(keptPath, "utf8")).toBe("kept");
      await expect(fs.access(excludedPath)).rejects.toThrow();
    } finally {
      await fs.rm(unrelated, { recursive: true, force: true });
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("excludes !-prefixed entries when given a relative path", async () => {
    // Same exclusion semantics, but with cwd-relative inputs (the form used
    // by repository-relative cache paths). Asserts the exclusion is matched
    // by tar's resolved absolute path, not by string prefix on the input.
    const root = path.join(dir, "tree");
    const keepDir = path.join(root, "keep");
    const dropDir = path.join(root, "drop");
    await fs.mkdir(keepDir, { recursive: true });
    await fs.mkdir(dropDir, { recursive: true });
    await fs.writeFile(path.join(keepDir, "k.txt"), "k");
    await fs.writeFile(path.join(dropDir, "d.txt"), "d");

    const archive = path.join(dir, "rel-excl.tar");
    // Relative includes + `!`-prefixed relative exclusion, both resolved
    // against `dir` (cwd).
    await fs.writeFile(
      archive,
      await streamToBuffer(createTarStream(["tree", "!tree/drop"], dir)),
    );

    const dst = path.join(dir, "out");
    await fs.mkdir(dst);
    await extractTarStream(archive, dst);

    expect(await fs.readFile(path.join(dst, "tree/keep/k.txt"), "utf8")).toBe(
      "k",
    );
    await expect(fs.access(path.join(dst, "tree/drop/d.txt"))).rejects.toThrow();
  });

  it("throws when only !-prefixed exclusion entries are provided", () => {
    // An exclusion-only list has no includes to pack. tar v7 throws or hangs
    // on an empty include set, so we mirror the empty-list guard.
    expect(() => createTarStream(["!/tmp/foo"], dir)).toThrow(
      /must not be empty/,
    );
  });

  it("expandGlobs + createTarStream round-trips `**/node_modules` (lerna recipe)", async () => {
    // Integration: the full save-side glob pipeline. Seeds node_modules at
    // two depths (mirroring the compat workflow's node-lerna job), runs
    // expandGlobs on the literal `**/node_modules` pattern, then pipes the
    // expanded paths through createTarStream. Extract and assert both
    // stamps survive — the production failure mode is that the literal glob
    // string is lstat()'d by tar and ENOENTs.
    const real = await fs.realpath(dir);
    await fs.mkdir(path.join(real, "node_modules"));
    await fs.mkdir(path.join(real, "packages", "a", "node_modules"), {
      recursive: true,
    });
    await fs.writeFile(path.join(real, "node_modules", "stamp"), "root");
    await fs.writeFile(
      path.join(real, "packages", "a", "node_modules", "stamp"),
      "nested",
    );

    const expanded = await expandGlobs([
      path.join(real, "**", "node_modules"),
    ]);
    expect(expanded.length).toBe(2);

    const archive = path.join(real, "lerna.tar");
    await fs.writeFile(
      archive,
      await streamToBuffer(createTarStream(expanded, real)),
    );

    // Wipe and restore to an unrelated cwd; absolute paths reconstruct at
    // their original location.
    await fs.rm(path.join(real, "node_modules"), { recursive: true });
    await fs.rm(path.join(real, "packages"), { recursive: true });
    const unrelated = await fs.mkdtemp(path.join(os.tmpdir(), "br-tar-cwd-"));
    try {
      await extractTarStream(archive, unrelated);
      expect(
        await fs.readFile(path.join(real, "node_modules", "stamp"), "utf8"),
      ).toBe("root");
      expect(
        await fs.readFile(
          path.join(real, "packages", "a", "node_modules", "stamp"),
          "utf8",
        ),
      ).toBe("nested");
    } finally {
      await fs.rm(unrelated, { recursive: true, force: true });
    }
  });
});
