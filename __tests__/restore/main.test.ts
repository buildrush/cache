import { describe, it, expect, vi, beforeEach } from "vitest";
import { PassThrough } from "node:stream";
import * as core from "@actions/core";
import { mintAndExchange } from "../../src/auth/exchange.js";
import { ExchangeError } from "../../src/auth/types.js";
import { CacheClientError } from "../../src/client/cacheClient.js";
import { computeCacheVersion } from "../../src/archive/version.js";
import { downloadToFile } from "../../src/transport/download.js";
import { extractTarStream } from "../../src/archive/tar.js";
import { decompressStream } from "../../src/archive/compress.js";

vi.mock("@actions/core");
vi.mock("../../src/auth/exchange.js");
vi.mock("../../src/transport/download.js", () => ({
  downloadToFile: vi.fn(),
}));
vi.mock("../../src/archive/tar.js", () => ({
  extractTarStream: vi.fn(),
}));

// decompressStream returns a fresh Transform (PassThrough) so a real
// node:stream/promises `pipeline()` can pass bytes from the input
// PassThrough → this PassThrough → the destination PassThrough.
vi.mock("../../src/archive/compress.js", () => ({
  decompressStream: vi.fn(() => new PassThrough()),
}));

vi.mock("../../src/archive/version.js", () => ({
  computeCacheVersion: vi.fn(() => "computed-version"),
}));

// Mock CacheClient with a constructable stub whose `lookupEntry` is a
// vi.fn() the tests can program. We share the function instance via a
// vi.hoisted ref so it survives the hoisted mock factory.
const cacheClientHoist = vi.hoisted(() => {
  const lookupEntry = vi.fn();
  class StubCacheClient {
    public lookupEntry = lookupEntry;
    constructor(_baseUrl: string, _token: string) {}
  }
  return { StubCacheClient, lookupEntry };
});

vi.mock("../../src/client/cacheClient.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/client/cacheClient.js")
  >("../../src/client/cacheClient.js");
  return {
    ...actual,
    CacheClient: cacheClientHoist.StubCacheClient,
  };
});

// Mock node:fs/promises so the download/extract path stays in memory:
// - mkdtemp returns a synthetic path.
// - open returns handles whose streams are passthroughs (so the decompress
//   pipeline can flow to "finish" instantly).
// - rm is a no-op.
vi.mock("node:fs/promises", async () => {
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  return {
    ...actual,
    default: actual,
    mkdtemp: vi.fn(async (prefix: string) => `${prefix}xyz`),
    rm: vi.fn(async () => undefined),
    open: vi.fn(async () => {
      const writeable = new PassThrough();
      const readable = new PassThrough();
      // The producer side: close the readable immediately so the
      // decompress pipeline (passthrough) emits 'finish' on the write side.
      readable.end();
      const handle = {
        createReadStream: () => readable,
        createWriteStream: () => writeable,
        close: vi.fn(async () => undefined),
        [Symbol.asyncDispose]: vi.fn(async () => undefined),
      };
      return handle;
    }),
  };
});

const inputs: Record<string, string> = {};
const multilineInputs: Record<string, string[]> = {};
const booleanInputs: Record<string, boolean> = {};

beforeEach(() => {
  vi.resetAllMocks();

  for (const k of Object.keys(inputs)) delete inputs[k];
  for (const k of Object.keys(multilineInputs)) delete multilineInputs[k];
  for (const k of Object.keys(booleanInputs)) delete booleanInputs[k];

  // Defaults
  inputs["key"] = "primary-key";
  // action.yml gives this input a default of "https://cache.buildrush.io"
  // — mirror that here so tests exercise the production code path.
  inputs["audience"] = "https://cache.buildrush.io";
  inputs["fallback"] = "";
  multilineInputs["path"] = ["/tmp/test"];
  multilineInputs["restore-keys"] = [];
  booleanInputs["enableCrossOsArchive"] = false;
  booleanInputs["lookup-only"] = false;
  booleanInputs["fail-on-cache-miss"] = false;

  vi.mocked(core.getInput).mockImplementation(
    (name: string) => inputs[name] ?? "",
  );
  vi.mocked(core.getMultilineInput).mockImplementation(
    (name: string) => multilineInputs[name] ?? [],
  );
  vi.mocked(core.getBooleanInput).mockImplementation(
    (name: string) => booleanInputs[name] ?? false,
  );

  // Default: computeCacheVersion stub returns a stable string.
  vi.mocked(computeCacheVersion).mockReturnValue("computed-version");

  // Default: decompress returns a fresh PassThrough Transform so a real
  // pipeline() can drive bytes from the input handle to the output handle.
  vi.mocked(decompressStream).mockImplementation(() => new PassThrough());

  // Default: download + extract no-op.
  vi.mocked(downloadToFile).mockResolvedValue(undefined);
  vi.mocked(extractTarStream).mockResolvedValue(undefined);
});

/**
 * Program the shared CacheClient lookup mock. Returns the mock fn so the
 * test can assert call args.
 */
function stubCacheClientLookup(
  behaviour:
    | { kind: "hit"; downloadUrl: string; matchedKey: string }
    | { kind: "miss" }
    | { kind: "throw"; error: unknown },
): ReturnType<typeof vi.fn> {
  const { lookupEntry } = cacheClientHoist;
  lookupEntry.mockReset();
  if (behaviour.kind === "hit") {
    lookupEntry.mockResolvedValue({
      downloadUrl: behaviour.downloadUrl,
      matchedKey: behaviour.matchedKey,
    });
  } else if (behaviour.kind === "miss") {
    lookupEntry.mockResolvedValue(null);
  } else {
    lookupEntry.mockRejectedValue(behaviour.error);
  }
  return lookupEntry;
}

// Import the SUT *after* vi.mock declarations so the mocks are in effect.
const { run } = await import("../../restore/src/main.js");

describe("restore main.run() — auth path", () => {
  it("exchange fails (oidc-rejected) + fallback=github → warning, no download, no setFailed", async () => {
    inputs["fallback"] = "github";
    vi.mocked(mintAndExchange).mockRejectedValue(
      new ExchangeError("oidc-rejected"),
    );

    await run();

    expect(core.setOutput).toHaveBeenCalledWith(
      "buildrush-reason",
      "oidc-rejected",
    );
    expect(core.setOutput).toHaveBeenCalledWith("cache-hit", "false");
    expect(core.setOutput).toHaveBeenCalledWith("cache-matched-key", "");
    expect(core.setOutput).toHaveBeenCalledWith(
      "cache-primary-key",
      "primary-key",
    );
    expect(core.exportVariable).not.toHaveBeenCalledWith(
      "ACTIONS_CACHE_DISABLED",
      "true",
    );
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(downloadToFile).not.toHaveBeenCalled();
    expect(extractTarStream).not.toHaveBeenCalled();
  });

  it("exchange fails + fallback=skip → ACTIONS_CACHE_DISABLED=true exported", async () => {
    inputs["fallback"] = "skip";
    vi.mocked(mintAndExchange).mockRejectedValue(
      new ExchangeError("network-error"),
    );

    await run();

    expect(core.setOutput).toHaveBeenCalledWith(
      "buildrush-reason",
      "network-error",
    );
    expect(core.exportVariable).toHaveBeenCalledWith(
      "ACTIONS_CACHE_DISABLED",
      "true",
    );
    expect(core.setOutput).toHaveBeenCalledWith("cache-hit", "false");
    expect(core.setOutput).toHaveBeenCalledWith("cache-matched-key", "");
    expect(downloadToFile).not.toHaveBeenCalled();
  });

  it("exchange fails + fallback=fail → setFailed, no download", async () => {
    inputs["fallback"] = "fail";
    vi.mocked(mintAndExchange).mockRejectedValue(
      new ExchangeError("rate-limited"),
    );

    await run();

    expect(core.setOutput).toHaveBeenCalledWith(
      "buildrush-reason",
      "rate-limited",
    );
    expect(core.setFailed).toHaveBeenCalledWith(
      "Build_Rush Cache unavailable — failing step (reason: rate-limited)",
    );
    expect(downloadToFile).not.toHaveBeenCalled();
  });

  it("invalid fallback input → setFailed, mintAndExchange NOT called, cache-primary-key still echoed", async () => {
    inputs["fallback"] = "bogus";

    await run();

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining("Invalid fallback value"),
    );
    expect(mintAndExchange).not.toHaveBeenCalled();
    expect(downloadToFile).not.toHaveBeenCalled();
    // cache-primary-key must be echoed even on input-validation failure so
    // downstream steps that read the output before noticing the step failed
    // still see the user's input.
    expect(core.setOutput).toHaveBeenCalledWith(
      "cache-primary-key",
      "primary-key",
    );
  });

  it("audience input is forwarded to mintAndExchange when non-empty", async () => {
    inputs["audience"] = "https://cache.buildrush.dev";
    vi.mocked(mintAndExchange).mockResolvedValue({ token: "tok" });
    stubCacheClientLookup({ kind: "miss" });

    await run();

    expect(mintAndExchange).toHaveBeenCalledWith(
      expect.objectContaining({ audience: "https://cache.buildrush.dev" }),
    );
  });

  it("BUILDRUSH_CACHE_URL env is forwarded as exchangeBaseUrl when set", async () => {
    const original = process.env.BUILDRUSH_CACHE_URL;
    process.env.BUILDRUSH_CACHE_URL = "https://staging.example";
    try {
      vi.mocked(mintAndExchange).mockResolvedValue({ token: "tok" });
      stubCacheClientLookup({ kind: "miss" });

      await run();

      expect(mintAndExchange).toHaveBeenCalledWith(
        expect.objectContaining({
          exchangeBaseUrl: "https://staging.example",
        }),
      );
    } finally {
      if (original === undefined) delete process.env.BUILDRUSH_CACHE_URL;
      else process.env.BUILDRUSH_CACHE_URL = original;
    }
  });
});

describe("restore main.run() — lookup + restore", () => {
  it("hit (matched == primary): cache-hit=true, download + extract called", async () => {
    vi.mocked(mintAndExchange).mockResolvedValue({ token: "tok" });
    stubCacheClientLookup({
      kind: "hit",
      downloadUrl: "https://dl/abc",
      matchedKey: "primary-key",
    });

    await run();

    expect(core.setOutput).toHaveBeenCalledWith(
      "cache-primary-key",
      "primary-key",
    );
    expect(core.setOutput).toHaveBeenCalledWith(
      "cache-matched-key",
      "primary-key",
    );
    expect(core.setOutput).toHaveBeenCalledWith("cache-hit", "true");
    expect(core.setOutput).toHaveBeenCalledWith("buildrush-reason", "");
    expect(downloadToFile).toHaveBeenCalledTimes(1);
    expect(downloadToFile).toHaveBeenCalledWith(
      "https://dl/abc",
      expect.stringContaining("cache.tar.zst"),
    );
    expect(extractTarStream).toHaveBeenCalledTimes(1);
    expect(extractTarStream).toHaveBeenCalledWith(
      expect.stringContaining("cache.tar"),
      process.cwd(),
    );
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it("partial hit (matched != primary): cache-hit=false, matched=<fallback>", async () => {
    multilineInputs["restore-keys"] = ["fallback-1", "fallback-2"];
    vi.mocked(mintAndExchange).mockResolvedValue({ token: "tok" });
    stubCacheClientLookup({
      kind: "hit",
      downloadUrl: "https://dl/abc",
      matchedKey: "fallback-1",
    });

    await run();

    expect(core.setOutput).toHaveBeenCalledWith(
      "cache-matched-key",
      "fallback-1",
    );
    expect(core.setOutput).toHaveBeenCalledWith("cache-hit", "false");
    expect(downloadToFile).toHaveBeenCalledTimes(1);
    expect(extractTarStream).toHaveBeenCalledTimes(1);
  });

  it("miss: cache-hit=false, matched-key='', no download/extract", async () => {
    vi.mocked(mintAndExchange).mockResolvedValue({ token: "tok" });
    stubCacheClientLookup({ kind: "miss" });

    await run();

    expect(core.setOutput).toHaveBeenCalledWith("cache-hit", "false");
    expect(core.setOutput).toHaveBeenCalledWith("cache-matched-key", "");
    expect(downloadToFile).not.toHaveBeenCalled();
    expect(extractTarStream).not.toHaveBeenCalled();
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it("miss + fail-on-cache-miss=true: setFailed called", async () => {
    booleanInputs["fail-on-cache-miss"] = true;
    vi.mocked(mintAndExchange).mockResolvedValue({ token: "tok" });
    stubCacheClientLookup({ kind: "miss" });

    await run();

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining("primary-key"),
    );
    expect(downloadToFile).not.toHaveBeenCalled();
  });

  it("lookup-only=true: outputs set after lookup, download/extract NOT called", async () => {
    booleanInputs["lookup-only"] = true;
    vi.mocked(mintAndExchange).mockResolvedValue({ token: "tok" });
    stubCacheClientLookup({
      kind: "hit",
      downloadUrl: "https://dl/abc",
      matchedKey: "primary-key",
    });

    await run();

    expect(core.setOutput).toHaveBeenCalledWith("cache-hit", "true");
    expect(core.setOutput).toHaveBeenCalledWith(
      "cache-matched-key",
      "primary-key",
    );
    expect(downloadToFile).not.toHaveBeenCalled();
    expect(extractTarStream).not.toHaveBeenCalled();
  });

  it("lookupEntry throws: warning emitted, cache-hit=false, no setFailed by default", async () => {
    vi.mocked(mintAndExchange).mockResolvedValue({ token: "tok" });
    stubCacheClientLookup({
      kind: "throw",
      error: new CacheClientError("boom", 503, "UNAVAILABLE", true),
    });

    await run();

    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining("Cache lookup failed"),
    );
    expect(core.setOutput).toHaveBeenCalledWith("cache-hit", "false");
    expect(core.setOutput).toHaveBeenCalledWith("cache-matched-key", "");
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(downloadToFile).not.toHaveBeenCalled();
  });

  it("lookupEntry throws + fail-on-cache-miss=true: setFailed called", async () => {
    booleanInputs["fail-on-cache-miss"] = true;
    vi.mocked(mintAndExchange).mockResolvedValue({ token: "tok" });
    stubCacheClientLookup({
      kind: "throw",
      error: new CacheClientError("boom", 503, "UNAVAILABLE", true),
    });

    await run();

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining("lookup error"),
    );
  });

  it("enableCrossOsArchive forwarded to computeCacheVersion", async () => {
    booleanInputs["enableCrossOsArchive"] = true;
    multilineInputs["path"] = ["dir-a", "dir-b"];
    vi.mocked(mintAndExchange).mockResolvedValue({ token: "tok" });
    stubCacheClientLookup({ kind: "miss" });

    await run();

    expect(computeCacheVersion).toHaveBeenCalledWith(
      ["dir-a", "dir-b"],
      "zstd",
      true,
    );
  });

  it("lookupEntry receives key + version + restoreKeys", async () => {
    multilineInputs["restore-keys"] = ["rk-1", "rk-2"];
    vi.mocked(mintAndExchange).mockResolvedValue({ token: "tok" });
    vi.mocked(computeCacheVersion).mockReturnValue("v-explicit");
    const lookupEntry = stubCacheClientLookup({ kind: "miss" });

    await run();

    expect(lookupEntry).toHaveBeenCalledWith({
      key: "primary-key",
      version: "v-explicit",
      restoreKeys: ["rk-1", "rk-2"],
    });
  });
});
