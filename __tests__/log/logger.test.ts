import { describe, it, expect, vi, beforeEach } from "vitest";
import * as core from "@actions/core";
import {
  debug,
  isVerbose,
  resolveVerbose,
  setVerbose,
} from "../../src/log/logger.js";

vi.mock("@actions/core");

describe("logger", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setVerbose(false);
    delete process.env.BUILDRUSH_CACHE_VERBOSE;
    // getInput defaults to "" (absent input) unless a test overrides it.
    vi.mocked(core.getInput).mockReturnValue("");
  });

  describe("debug routing", () => {
    it("routes to core.debug (hidden) when verbose is off", () => {
      setVerbose(false);
      debug("hello");
      expect(core.debug).toHaveBeenCalledWith("hello");
      expect(core.info).not.toHaveBeenCalled();
    });

    it("routes to core.info with a [debug] prefix when verbose is on", () => {
      setVerbose(true);
      debug("hello");
      expect(core.info).toHaveBeenCalledWith("[debug] hello");
      expect(core.debug).not.toHaveBeenCalled();
    });
  });

  describe("setVerbose / isVerbose", () => {
    it("latches the verbose flag", () => {
      expect(isVerbose()).toBe(false);
      setVerbose(true);
      expect(isVerbose()).toBe(true);
      setVerbose(false);
      expect(isVerbose()).toBe(false);
    });
  });

  describe("resolveVerbose", () => {
    it("returns true when the verbose input is 'true'", () => {
      vi.mocked(core.getInput).mockReturnValue("true");
      expect(resolveVerbose()).toBe(true);
    });

    it("returns false when the input is 'false' and the env is unset", () => {
      vi.mocked(core.getInput).mockReturnValue("false");
      expect(resolveVerbose()).toBe(false);
    });

    it("returns false when the input is absent and the env is unset", () => {
      vi.mocked(core.getInput).mockReturnValue("");
      expect(resolveVerbose()).toBe(false);
    });

    it("falls back to BUILDRUSH_CACHE_VERBOSE=true when the input is absent", () => {
      vi.mocked(core.getInput).mockReturnValue("");
      process.env.BUILDRUSH_CACHE_VERBOSE = "true";
      expect(resolveVerbose()).toBe(true);
    });

    it("env fallback enables verbose even when the input is 'false'", () => {
      vi.mocked(core.getInput).mockReturnValue("false");
      process.env.BUILDRUSH_CACHE_VERBOSE = "true";
      expect(resolveVerbose()).toBe(true);
    });

    it("is case- and whitespace-insensitive for the input value", () => {
      vi.mocked(core.getInput).mockReturnValue("  TRUE  ");
      expect(resolveVerbose()).toBe(true);
    });

    it("ignores a non-'true' env value", () => {
      vi.mocked(core.getInput).mockReturnValue("");
      process.env.BUILDRUSH_CACHE_VERBOSE = "1";
      expect(resolveVerbose()).toBe(false);
    });
  });
});
