import { describe, it, expect } from "vitest";
import * as crypto from "node:crypto";
import { computeCacheVersion } from "../../src/archive/version.js";

// Golden tests against the upstream actions/cache@v5 algorithm
// (https://github.com/actions/toolkit/blob/main/packages/cache/src/internal/cacheUtils.ts).
// versionSalt = "1.0".
function hash(parts: string[]): string {
  return crypto.createHash("sha256").update(parts.join("|")).digest("hex");
}

describe("computeCacheVersion", () => {
  it("matches upstream for paths=[node_modules], zstd, no-cross-os, linux", () => {
    const got = computeCacheVersion(["node_modules"], "zstd", false, "linux");
    expect(got).toBe(hash(["node_modules", "zstd", "1.0"]));
  });

  it("matches upstream for multi-path input, gzip, linux", () => {
    const got = computeCacheVersion(
      ["pkg/a", "pkg/b"],
      "gzip",
      false,
      "linux",
    );
    expect(got).toBe(hash(["pkg/a", "pkg/b", "gzip", "1.0"]));
  });

  it("includes windows-only when platform is win32 and crossOs is false", () => {
    const got = computeCacheVersion(["node_modules"], "zstd", false, "win32");
    expect(got).toBe(hash(["node_modules", "zstd", "windows-only", "1.0"]));
  });

  it("omits windows-only when crossOs is true on win32", () => {
    const got = computeCacheVersion(["node_modules"], "zstd", true, "win32");
    expect(got).toBe(hash(["node_modules", "zstd", "1.0"]));
  });

  it("omits windows-only when on a non-win32 platform regardless of crossOs", () => {
    const got = computeCacheVersion(["node_modules"], "zstd", false, "darwin");
    expect(got).toBe(hash(["node_modules", "zstd", "1.0"]));
  });

  it("omits compressionMethod when undefined", () => {
    const got = computeCacheVersion(["a"], undefined, false, "linux");
    expect(got).toBe(hash(["a", "1.0"]));
  });

  it("preserves path order (a,b) != (b,a)", () => {
    const a = computeCacheVersion(["a", "b"], "zstd", false, "linux");
    const b = computeCacheVersion(["b", "a"], "zstd", false, "linux");
    expect(a).not.toBe(b);
  });

  it("produces a distinct hash for method 'none'", () => {
    const got = computeCacheVersion(["node_modules"], "none", false, "linux");
    expect(got).toBe(hash(["node_modules", "none", "1.0"]));
  });

  it("'none' and 'zstd' are different namespaces", () => {
    const none = computeCacheVersion(["a"], "none", false, "linux");
    const zstd = computeCacheVersion(["a"], "zstd", false, "linux");
    expect(none).not.toBe(zstd);
  });
});
