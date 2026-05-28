import { describe, it, expect } from "vitest";
import { PassThrough, Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  compressStream,
  decompressStream,
} from "../../src/archive/compress.js";

async function collectPipeline(
  source: Readable,
  transform: ReturnType<typeof compressStream> | ReturnType<typeof decompressStream>,
): Promise<Buffer> {
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

describe("compress/decompress", () => {
  it("round-trips zstd cleanly on compressible payloads", async () => {
    const payload = Buffer.from("hello world".repeat(1000));
    const compressed = await collectPipeline(
      Readable.from([payload]),
      compressStream(),
    );
    expect(compressed.length).toBeLessThan(payload.length);
    const decompressed = await collectPipeline(
      Readable.from([compressed]),
      decompressStream(),
    );
    expect(decompressed.equals(payload)).toBe(true);
  });

  it("round-trips small random binary payload", async () => {
    const payload = Buffer.alloc(2048);
    for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
    const compressed = await collectPipeline(
      Readable.from([payload]),
      compressStream(),
    );
    const decompressed = await collectPipeline(
      Readable.from([compressed]),
      decompressStream(),
    );
    expect(decompressed.equals(payload)).toBe(true);
  });

  it("propagates upstream errors through pipeline()", async () => {
    // Pipeline propagates the source's error to the awaiting caller and
    // destroys downstream stages — exactly the behaviour the hand-rolled
    // `someTransform(input).pipe(out).on('error', reject)` form swallowed.
    const failing = new Readable({
      read() {
        this.destroy(new Error("upstream boom"));
      },
    });
    const sink = new PassThrough();
    sink.resume();
    await expect(pipeline(failing, compressStream(), sink)).rejects.toThrow(
      "upstream boom",
    );
  });
});
