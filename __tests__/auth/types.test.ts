import { describe, it, expect } from "vitest";
import { isFallbackMode } from "../../src/auth/types.js";

describe("isFallbackMode", () => {
  it.each(["github", "skip", "fail"])("accepts %s", (value) => {
    expect(isFallbackMode(value)).toBe(true);
  });

  it.each(["", "GITHUB", "noop", "true"])("rejects %s", (value) => {
    expect(isFallbackMode(value)).toBe(false);
  });
});
