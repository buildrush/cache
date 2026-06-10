import { describe, it, expect } from "vitest";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  isCompression,
  resolveCompression,
  DEFAULT_COMPRESSION,
} from "../../src/archive/compression.js";

async function collect(source: Readable, transform: Transform): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(chunk);
      cb();
    },
  });
  await pipeline(source, transform, sink);
  return Buffer.concat(chunks);
}

describe("isCompression", () => {
  it("accepts the three supported values", () => {
    expect(isCompression("zstd-fast")).toBe(true);
    expect(isCompression("zstd")).toBe(true);
    expect(isCompression("none")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isCompression("lz4")).toBe(false);
    expect(isCompression("gzip")).toBe(false);
    expect(isCompression("")).toBe(false);
    expect(isCompression("ZSTD")).toBe(false);
  });
});

describe("DEFAULT_COMPRESSION", () => {
  it("is zstd-fast", () => {
    expect(DEFAULT_COMPRESSION).toBe("zstd-fast");
  });
});

describe("resolveCompression", () => {
  it("zstd-fast and zstd share the 'zstd' version namespace", () => {
    expect(resolveCompression("zstd-fast").versionMethod).toBe("zstd");
    expect(resolveCompression("zstd").versionMethod).toBe("zstd");
  });

  it("none uses its own version namespace", () => {
    expect(resolveCompression("none").versionMethod).toBe("none");
  });

  it("every tier yields encoder/decoder Transform factories", () => {
    for (const c of ["zstd-fast", "zstd", "none"] as const) {
      const r = resolveCompression(c);
      expect(r.makeCompress()).toBeInstanceOf(Transform);
      expect(r.makeDecompress()).toBeInstanceOf(Transform);
    }
  });

  it("none tier round-trips raw bytes through its resolveCompression factories", async () => {
    const { makeCompress, makeDecompress } = resolveCompression("none");
    const payload = Buffer.from("raw bytes via resolve");
    const piped = await collect(Readable.from([payload]), makeCompress());
    const out = await collect(Readable.from([piped]), makeDecompress());
    expect(out.equals(payload)).toBe(true);
  });
});
