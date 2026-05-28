import { describe, it, expect, vi } from "vitest";
import { withRetry, RetryError } from "../../src/retry/retry.js";

describe("withRetry", () => {
  it("returns the first success", async () => {
    const fn = vi.fn().mockResolvedValueOnce("ok");
    const result = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 1 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on isRetryable=true and eventually succeeds", async () => {
    let calls = 0;
    const fn = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls < 3) throw new RetryError("transient", true);
      return "ok";
    });
    const result = await withRetry(fn, { maxAttempts: 5, baseDelayMs: 1 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry on isRetryable=false", async () => {
    const err = new RetryError("permanent", false);
    const fn = vi.fn().mockRejectedValue(err);
    await expect(
      withRetry(fn, { maxAttempts: 5, baseDelayMs: 1 }),
    ).rejects.toThrow("permanent");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry on a non-RetryError", async () => {
    const err = new Error("kaboom");
    const fn = vi.fn().mockRejectedValue(err);
    await expect(
      withRetry(fn, { maxAttempts: 5, baseDelayMs: 1 }),
    ).rejects.toThrow("kaboom");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxAttempts", async () => {
    const err = new RetryError("transient", true);
    const fn = vi.fn().mockRejectedValue(err);
    await expect(
      withRetry(fn, { maxAttempts: 3, baseDelayMs: 1 }),
    ).rejects.toThrow("transient");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("isRetryable predicate overrides the default RetryError check", async () => {
    class FooError extends Error {
      constructor(message: string, public readonly retryable: boolean) {
        super(message);
      }
    }
    let calls = 0;
    const fn = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls < 2) throw new FooError("transient", true);
      return "ok";
    });
    const result = await withRetry(fn, {
      maxAttempts: 4,
      baseDelayMs: 1,
      isRetryable: (err) => err instanceof FooError && err.retryable,
    });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("isRetryable predicate returning false short-circuits retries", async () => {
    class FooError extends Error {
      constructor(message: string, public readonly retryable: boolean) {
        super(message);
      }
    }
    const fn = vi.fn().mockRejectedValue(new FooError("permanent", false));
    await expect(
      withRetry(fn, {
        maxAttempts: 4,
        baseDelayMs: 1,
        isRetryable: (err) => err instanceof FooError && err.retryable,
      }),
    ).rejects.toThrow("permanent");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
