import { describe, it, expect, vi, beforeEach } from "vitest";
import * as core from "@actions/core";
import { applyFallback } from "../../src/auth/fallback.js";

vi.mock("@actions/core", () => ({
  warning: vi.fn(),
  error: vi.fn(),
}));

beforeEach(() => {
  vi.resetAllMocks();
});

describe("applyFallback", () => {
  describe("mode: github", () => {
    it("returns shouldFail=false, disableCache=false", () => {
      const result = applyFallback("github", "network-error");
      expect(result).toEqual({ shouldFail: false, disableCache: false });
    });

    it("emits a warning containing the expected prefix and reason", () => {
      applyFallback("github", "oidc-rejected");
      expect(core.warning).toHaveBeenCalledWith(
        "Build_Rush Cache unavailable — falling back to GitHub cache (reason: oidc-rejected)"
      );
      expect(core.error).not.toHaveBeenCalled();
    });
  });

  describe("mode: skip", () => {
    it("returns shouldFail=false, disableCache=true", () => {
      const result = applyFallback("skip", "rate-limited");
      expect(result).toEqual({ shouldFail: false, disableCache: true });
    });

    it("emits the skip warning text", () => {
      applyFallback("skip", "rate-limited");
      expect(core.warning).toHaveBeenCalledWith(
        "Build_Rush Cache unavailable — caching skipped for this step (reason: rate-limited)"
      );
    });
  });

  describe("mode: fail", () => {
    it("returns shouldFail=true, disableCache=false", () => {
      const result = applyFallback("fail", "installation-not-enabled");
      expect(result).toEqual({ shouldFail: true, disableCache: false });
    });

    it("emits an error annotation", () => {
      applyFallback("fail", "installation-not-enabled");
      expect(core.error).toHaveBeenCalledWith(
        "Build_Rush Cache unavailable — failing step (reason: installation-not-enabled)"
      );
      expect(core.warning).not.toHaveBeenCalled();
    });
  });
});
