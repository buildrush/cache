import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { Readable } from "node:stream";
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
});
