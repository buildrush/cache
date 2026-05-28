import { describe, it, expect } from "vitest";
import {
  formatBytes,
  formatDuration,
  formatSpeed,
  formatRatio,
  shortVersion,
} from "../../src/log/format.js";

describe("formatBytes", () => {
  it.each<[number, string]>([
    [0, "0 B"],
    [1, "1 B"],
    [123, "123 B"],
    [1023, "1023 B"],
    [1024, "1.0 KB"],
    [1024 * 45.7, "45.7 KB"],
    [1024 * 1024, "1.0 MB"],
    [1024 * 1024 * 12.3, "12.3 MB"],
    [1024 * 1024 * 1024, "1.0 GB"],
    [1024 * 1024 * 1024 * 1.4, "1.4 GB"],
  ])("formatBytes(%i) === %s", (input, expected) => {
    expect(formatBytes(input)).toBe(expected);
  });
});

describe("formatDuration", () => {
  it.each<[number, string]>([
    [0, "0ms"],
    [1, "1ms"],
    [345, "345ms"],
    [999, "999ms"],
    [1000, "1.0s"],
    [1400, "1.4s"],
    [59999, "60.0s"],
    [60000, "1m0s"],
    [192000, "3m12s"],
  ])("formatDuration(%i ms) === %s", (input, expected) => {
    expect(formatDuration(input)).toBe(expected);
  });
});

describe("formatSpeed", () => {
  it("returns empty string when duration < 50 ms", () => {
    expect(formatSpeed(1_000_000, 49)).toBe("");
  });

  it("formats MB/s for typical transfer", () => {
    // 12 MiB in 1400 ms ≈ 8.6 MB/s
    expect(formatSpeed(12 * 1024 * 1024, 1400)).toBe("8.6 MB/s");
  });

  it("formats KB/s for slow transfer", () => {
    expect(formatSpeed(50 * 1024, 500)).toBe("100.0 KB/s");
  });
});

describe("formatRatio", () => {
  it("returns empty string when uncompressed < 1024", () => {
    expect(formatRatio(500, 100)).toBe("");
  });

  it("returns N.Nx for normal ratio", () => {
    expect(formatRatio(45.7 * 1024 * 1024, 12.3 * 1024 * 1024)).toBe("3.7x");
  });

  it("rounds 1:1 to 1.0x", () => {
    expect(formatRatio(2048, 2048)).toBe("1.0x");
  });
});

describe("shortVersion", () => {
  it("returns first 12 hex chars", () => {
    expect(shortVersion("4e1b3f0a2c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f")).toBe(
      "4e1b3f0a2c9d",
    );
  });

  it("returns input unchanged when 12 chars or fewer", () => {
    expect(shortVersion("abc")).toBe("abc");
  });

  it("returns input unchanged when exactly 12 chars", () => {
    expect(shortVersion("abcdefghijkl")).toBe("abcdefghijkl");
  });
});
