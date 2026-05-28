import { PassThrough } from "node:stream";

/**
 * Forwarding PassThrough that totals the byte length of every chunk it sees.
 * Used by the save flow to capture the uncompressed-tar byte count for the
 * compression-ratio line, without buffering anything.
 */
export class CountingPassThrough extends PassThrough {
  bytes = 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override _transform(chunk: any, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    if (Buffer.isBuffer(chunk)) {
      this.bytes += chunk.length;
    } else if (typeof chunk === "string") {
      this.bytes += Buffer.byteLength(chunk);
    } else if (chunk && typeof chunk.length === "number") {
      this.bytes += chunk.length;
    }
    this.push(chunk);
    cb();
  }
}
