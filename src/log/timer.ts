/**
 * High-resolution wall-clock timer. Used to time download, extract, archive,
 * and upload phases for verbose logging. Backed by `process.hrtime.bigint()`
 * so it isn't affected by system clock adjustments.
 */
export class Timer {
  private readonly start = process.hrtime.bigint();

  elapsedMs(): number {
    return Number(process.hrtime.bigint() - this.start) / 1e6;
  }
}
