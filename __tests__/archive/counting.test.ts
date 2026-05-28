import { describe, it, expect } from "vitest";
import { pipeline } from "node:stream/promises";
import { PassThrough, Readable, Writable } from "node:stream";
import { CountingPassThrough } from "../../src/archive/counting.js";

describe("CountingPassThrough", () => {
  it("counts bytes flowing through and forwards them unchanged", async () => {
    const counter = new CountingPassThrough();
    const sink: Buffer[] = [];

    await pipeline(
      Readable.from([Buffer.from("hello, "), Buffer.from("world!")]),
      counter,
      new Writable({
        write(chunk: Buffer, _enc, cb) {
          sink.push(chunk);
          cb();
        },
      }),
    );

    expect(counter.bytes).toBe(13); // "hello, world!"
    expect(Buffer.concat(sink).toString()).toBe("hello, world!");
  });

  it("starts at 0 bytes", () => {
    expect(new CountingPassThrough().bytes).toBe(0);
  });

  it("composes with a plain PassThrough downstream", async () => {
    const counter = new CountingPassThrough();
    const next = new PassThrough();
    const sink: Buffer[] = [];

    await pipeline(
      Readable.from([Buffer.alloc(1024, 0x61)]),
      counter,
      next,
      new Writable({
        write(chunk: Buffer, _enc, cb) {
          sink.push(chunk);
          cb();
        },
      }),
    );

    expect(counter.bytes).toBe(1024);
    expect(Buffer.concat(sink).length).toBe(1024);
  });
});
