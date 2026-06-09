import { describe, it, expect, vi, beforeEach } from "vitest";
import { PassThrough } from "node:stream";
import * as core from "@actions/core";
import { mintAndExchange } from "../../src/auth/exchange.js";
import { ExchangeError } from "../../src/auth/types.js";
import { CacheClientError } from "../../src/client/cacheClient.js";
import { computeCacheVersion } from "../../src/archive/version.js";
import { putSingleShot, putChunked } from "../../src/transport/upload.js";
import { createTarStream } from "../../src/archive/tar.js";
import { compressStream } from "../../src/archive/compress.js";
import { STATE_CACHE_MATCHED_KEY } from "../../src/state.js";

// Pin os.homedir for the tilde-expansion test below; spread `actual` so
// os.tmpdir() (used by save/src/main.ts) still returns a real path.
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => "/home/runner" };
});

vi.mock("@actions/core");
vi.mock("../../src/auth/exchange.js");
vi.mock("../../src/transport/upload.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/transport/upload.js")
  >("../../src/transport/upload.js");
  return {
    ...actual,
    putSingleShot: vi.fn(),
    putChunked: vi.fn(),
  };
});
vi.mock("../../src/archive/tar.js", () => ({
  createTarStream: vi.fn(() => {
    const pt = new PassThrough();
    pt.end();
    return pt;
  }),
}));

// Pass-through expandGlobs so the test asserts the tilde→tar contract
// without filesystem dependency. Real glob behavior is covered end-to-end
// in __tests__/archive/paths.test.ts and __tests__/archive/tar.test.ts.
vi.mock("../../src/archive/paths.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/archive/paths.js")
  >("../../src/archive/paths.js");
  return {
    ...actual,
    expandGlobs: vi.fn(async (paths: string[]) => paths),
  };
});

// compressStream returns a fresh Transform (PassThrough) so a real
// node:stream/promises `pipeline()` carries bytes through:
//   tarStream (PassThrough, ends immediately) → compressStream
//   PassThrough → output PassThrough.
vi.mock("../../src/archive/compress.js", () => ({
  compressStream: vi.fn(() => new PassThrough()),
}));

const timerHoist = vi.hoisted(() => {
  const queue: number[] = [];
  return {
    queue,
    Timer: vi.fn(function (this: unknown) {
      return { elapsedMs: () => (queue.length > 0 ? queue.shift()! : 0) };
    }),
  };
});

vi.mock("../../src/log/timer.js", () => ({ Timer: timerHoist.Timer }));

const countingHoist = vi.hoisted(() => ({ bytes: 0 }));

vi.mock("../../src/archive/counting.js", async () => {
  const { PassThrough } = await import("node:stream");
  return {
    CountingPassThrough: class StubCounter extends PassThrough {
      get bytes() {
        return countingHoist.bytes;
      }
    },
  };
});

vi.mock("../../src/archive/version.js", () => ({
  computeCacheVersion: vi.fn(() => "computed-version"),
}));

// Mock CacheClient with a constructable stub whose `createEntry` and
// `finalizeEntry` are vi.fn() instances the tests can program. We share
// the function instances via a vi.hoisted ref so they survive the hoisted
// mock factory.
const cacheClientHoist = vi.hoisted(() => {
  const createEntry = vi.fn();
  const finalizeEntry = vi.fn();
  class StubCacheClient {
    public createEntry = createEntry;
    public finalizeEntry = finalizeEntry;
    constructor(_baseUrl: string, _token: string) {}
  }
  return { StubCacheClient, createEntry, finalizeEntry };
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

// Mock node:fs/promises so the archive flow stays in memory:
// - mkdtemp returns a synthetic path.
// - open returns a handle whose write stream is a passthrough.
// - stat returns a configurable size (set via a module-scope ref).
// - readFile returns a Buffer of the configured size.
// - rm is a no-op.
const fsStub = vi.hoisted(() => ({ size: 0 }));

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
      return {
        createWriteStream: () => writeable,
        close: vi.fn(async () => undefined),
      };
    }),
    stat: vi.fn(async () => ({ size: fsStub.size })),
    readFile: vi.fn(async () => Buffer.alloc(fsStub.size)),
  };
});

const inputs: Record<string, string> = {};
const multilineInputs: Record<string, string[]> = {};
const booleanInputs: Record<string, boolean> = {};

beforeEach(() => {
  vi.resetAllMocks();
  timerHoist.queue.length = 0;
  countingHoist.bytes = 0;
  timerHoist.Timer.mockImplementation(function (this: unknown) {
    return { elapsedMs: () => (timerHoist.queue.length > 0 ? timerHoist.queue.shift()! : 0) };
  });

  for (const k of Object.keys(inputs)) delete inputs[k];
  for (const k of Object.keys(multilineInputs)) delete multilineInputs[k];
  for (const k of Object.keys(booleanInputs)) delete booleanInputs[k];

  // Defaults
  inputs["key"] = "primary-key";
  // action.yml gives this input a default of "https://cache.buildrush.io"
  // — mirror that here so tests exercise the production code path.
  inputs["audience"] = "https://cache.buildrush.io";
  inputs["fallback"] = "";
  inputs["upload-chunk-size"] = "";
  multilineInputs["path"] = ["/tmp/test"];
  booleanInputs["enableCrossOsArchive"] = false;

  fsStub.size = 1024;

  vi.mocked(core.getInput).mockImplementation(
    (name: string) => inputs[name] ?? "",
  );
  vi.mocked(core.getMultilineInput).mockImplementation(
    (name: string) => multilineInputs[name] ?? [],
  );
  vi.mocked(core.getBooleanInput).mockImplementation(
    (name: string) => booleanInputs[name] ?? false,
  );

  vi.mocked(computeCacheVersion).mockReturnValue("computed-version");

  // Re-install the tar + compress passthrough defaults since
  // vi.resetAllMocks() clears their implementations.
  vi.mocked(createTarStream).mockImplementation(() => {
    const pt = new PassThrough();
    pt.end();
    return pt;
  });
  vi.mocked(compressStream).mockImplementation(() => new PassThrough());

  vi.mocked(putSingleShot).mockResolvedValue(undefined);
  vi.mocked(putChunked).mockResolvedValue(undefined);

  cacheClientHoist.createEntry.mockReset();
  cacheClientHoist.finalizeEntry.mockReset();
});

// Import the SUT *after* vi.mock declarations so the mocks are in effect.
const { run } = await import("../../save/src/main.js");

describe("save main.run() — auth path", () => {
  it("exchange fails (oidc-rejected) + fallback=github → warning, no archive/upload/finalize, no setFailed", async () => {
    inputs["fallback"] = "github";
    vi.mocked(mintAndExchange).mockRejectedValue(
      new ExchangeError("oidc-rejected"),
    );

    await run();

    expect(core.setOutput).toHaveBeenCalledWith(
      "buildrush-reason",
      "oidc-rejected",
    );
    expect(core.exportVariable).not.toHaveBeenCalledWith(
      "ACTIONS_CACHE_DISABLED",
      "true",
    );
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(createTarStream).not.toHaveBeenCalled();
    expect(putSingleShot).not.toHaveBeenCalled();
    expect(putChunked).not.toHaveBeenCalled();
    expect(cacheClientHoist.createEntry).not.toHaveBeenCalled();
    expect(cacheClientHoist.finalizeEntry).not.toHaveBeenCalled();
  });

  it("exchange fails + fallback=skip → ACTIONS_CACHE_DISABLED=true exported, no archive/upload/finalize", async () => {
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
    expect(createTarStream).not.toHaveBeenCalled();
    expect(putSingleShot).not.toHaveBeenCalled();
    expect(putChunked).not.toHaveBeenCalled();
    expect(cacheClientHoist.finalizeEntry).not.toHaveBeenCalled();
  });

  it("exchange fails + fallback=fail → setFailed, no archive/upload/finalize", async () => {
    inputs["fallback"] = "fail";
    vi.mocked(mintAndExchange).mockRejectedValue(
      new ExchangeError("service-unavailable"),
    );

    await run();

    expect(core.setFailed).toHaveBeenCalledWith(
      "Build_Rush Cache unavailable — failing step (reason: service-unavailable)",
    );
    expect(createTarStream).not.toHaveBeenCalled();
    expect(putSingleShot).not.toHaveBeenCalled();
    expect(putChunked).not.toHaveBeenCalled();
    expect(cacheClientHoist.finalizeEntry).not.toHaveBeenCalled();
  });

  it("invalid fallback input → setFailed, nothing else called", async () => {
    inputs["fallback"] = "bogus";

    await run();

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining("Invalid fallback value"),
    );
    expect(mintAndExchange).not.toHaveBeenCalled();
    expect(createTarStream).not.toHaveBeenCalled();
    expect(putSingleShot).not.toHaveBeenCalled();
    expect(putChunked).not.toHaveBeenCalled();
    expect(cacheClientHoist.createEntry).not.toHaveBeenCalled();
    expect(cacheClientHoist.finalizeEntry).not.toHaveBeenCalled();
  });

  it("audience input is forwarded to mintAndExchange when non-empty", async () => {
    inputs["audience"] = "https://cache.buildrush.dev";
    vi.mocked(mintAndExchange).mockResolvedValue({ token: "tok" });
    cacheClientHoist.createEntry.mockResolvedValue("https://up/abc");
    cacheClientHoist.finalizeEntry.mockResolvedValue(undefined);

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
      cacheClientHoist.createEntry.mockResolvedValue("https://up/abc");
      cacheClientHoist.finalizeEntry.mockResolvedValue(undefined);

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

describe("save main.run() — archive + upload + finalize", () => {
  it("happy path, small file: putSingleShot called, putChunked NOT called, finalize called", async () => {
    fsStub.size = 1024; // 1 KiB
    vi.mocked(mintAndExchange).mockResolvedValue({ token: "tok" });
    cacheClientHoist.createEntry.mockResolvedValue("https://up/abc");
    cacheClientHoist.finalizeEntry.mockResolvedValue(undefined);

    await run();

    expect(cacheClientHoist.createEntry).toHaveBeenCalledWith({
      key: "primary-key",
      version: "computed-version",
      sizeBytes: 1024,
    });
    expect(putSingleShot).toHaveBeenCalledTimes(1);
    expect(putSingleShot).toHaveBeenCalledWith(
      "https://up/abc",
      expect.any(String),
      1024,
    );
    expect(putChunked).not.toHaveBeenCalled();
    expect(cacheClientHoist.finalizeEntry).toHaveBeenCalledWith({
      key: "primary-key",
      version: "computed-version",
      sizeBytes: 1024,
    });
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it("happy path, large file: putChunked called with the configured chunkSize, putSingleShot NOT called, finalize called", async () => {
    fsStub.size = 200 * 1024 * 1024; // 200 MiB
    inputs["upload-chunk-size"] = "16777216"; // 16 MiB
    vi.mocked(mintAndExchange).mockResolvedValue({ token: "tok" });
    cacheClientHoist.createEntry.mockResolvedValue("https://up/big?upload_id=AAANsU");
    cacheClientHoist.finalizeEntry.mockResolvedValue(undefined);

    await run();

    expect(putChunked).toHaveBeenCalledTimes(1);
    expect(putChunked).toHaveBeenCalledWith(
      "https://up/big?upload_id=AAANsU",
      expect.stringContaining("cache.tar.zst"),
      200 * 1024 * 1024,
      16777216,
    );
    expect(putSingleShot).not.toHaveBeenCalled();
    expect(cacheClientHoist.finalizeEntry).toHaveBeenCalledWith({
      key: "primary-key",
      version: "computed-version",
      sizeBytes: 200 * 1024 * 1024,
    });
  });

  it("createEntry rejects with ALREADY_EXISTS: info logged, no upload, no finalize", async () => {
    vi.mocked(mintAndExchange).mockResolvedValue({ token: "tok" });
    cacheClientHoist.createEntry.mockRejectedValue(
      new CacheClientError("exists", 409, "ALREADY_EXISTS", false),
    );

    await run();

    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining("already exists"),
    );
    expect(putSingleShot).not.toHaveBeenCalled();
    expect(putChunked).not.toHaveBeenCalled();
    expect(cacheClientHoist.finalizeEntry).not.toHaveBeenCalled();
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it("createEntry rejects with other CacheClientError: warning logged, no upload, no finalize", async () => {
    vi.mocked(mintAndExchange).mockResolvedValue({ token: "tok" });
    cacheClientHoist.createEntry.mockRejectedValue(
      new CacheClientError("boom", 500, "INTERNAL", true),
    );

    await run();

    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining("Failed to reserve cache entry"),
    );
    expect(putSingleShot).not.toHaveBeenCalled();
    expect(putChunked).not.toHaveBeenCalled();
    expect(cacheClientHoist.finalizeEntry).not.toHaveBeenCalled();
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it("upload fails: warning logged, finalize NOT called", async () => {
    vi.mocked(mintAndExchange).mockResolvedValue({ token: "tok" });
    cacheClientHoist.createEntry.mockResolvedValue("https://up/abc");
    vi.mocked(putSingleShot).mockRejectedValue(new Error("upload boom"));

    await run();

    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining("Failed to upload cache"),
    );
    expect(cacheClientHoist.finalizeEntry).not.toHaveBeenCalled();
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it("finalize fails: warning logged (upload already happened)", async () => {
    vi.mocked(mintAndExchange).mockResolvedValue({ token: "tok" });
    cacheClientHoist.createEntry.mockResolvedValue("https://up/abc");
    vi.mocked(putSingleShot).mockResolvedValue(undefined);
    cacheClientHoist.finalizeEntry.mockRejectedValue(
      new CacheClientError("finalize boom", 500, "INTERNAL", true),
    );

    await run();

    expect(putSingleShot).toHaveBeenCalledTimes(1);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining("Failed to finalize cache"),
    );
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it("enableCrossOsArchive forwarded to computeCacheVersion", async () => {
    booleanInputs["enableCrossOsArchive"] = true;
    multilineInputs["path"] = ["dir-a", "dir-b"];
    vi.mocked(mintAndExchange).mockResolvedValue({ token: "tok" });
    cacheClientHoist.createEntry.mockResolvedValue("https://up/abc");
    cacheClientHoist.finalizeEntry.mockResolvedValue(undefined);

    await run();

    expect(computeCacheVersion).toHaveBeenCalledWith(
      ["dir-a", "dir-b"],
      "zstd",
      true,
    );
  });

  it("expands `~` for the tar pack but keeps the literal string for computeCacheVersion", async () => {
    multilineInputs["path"] = ["~/.cache/go-build", "/abs/foo"];
    vi.mocked(mintAndExchange).mockResolvedValue({ token: "tok" });
    cacheClientHoist.createEntry.mockResolvedValue("https://up/abc");
    cacheClientHoist.finalizeEntry.mockResolvedValue(undefined);

    await run();

    // Literal `~/...` preserved so the digest stays stable across runners
    // with different $HOME (see src/archive/version.ts).
    expect(computeCacheVersion).toHaveBeenCalledWith(
      ["~/.cache/go-build", "/abs/foo"],
      "zstd",
      false,
    );
    // node-tar receives the expanded absolute path so it can resolve the
    // source directory; non-tilde paths pass through unchanged.
    expect(createTarStream).toHaveBeenCalledWith(
      ["/home/runner/.cache/go-build", "/abs/foo"],
      expect.any(String),
    );
  });

  it("upload-chunk-size input parsed to int and forwarded to putChunked", async () => {
    fsStub.size = 200 * 1024 * 1024; // 200 MiB, exceeds threshold
    inputs["upload-chunk-size"] = "8000000";
    vi.mocked(mintAndExchange).mockResolvedValue({ token: "tok" });
    cacheClientHoist.createEntry.mockResolvedValue("https://up/big?upload_id=AAANsU");
    cacheClientHoist.finalizeEntry.mockResolvedValue(undefined);

    await run();

    expect(putChunked).toHaveBeenCalledWith(
      "https://up/big?upload_id=AAANsU",
      expect.stringContaining("cache.tar.zst"),
      expect.any(Number),
      8000000,
    );
  });

  it("malformed upload-chunk-size falls back to DEFAULT_CHUNK_SIZE (32 MiB)", async () => {
    fsStub.size = 200 * 1024 * 1024; // 200 MiB, exceeds threshold
    inputs["upload-chunk-size"] = "not-a-number";
    vi.mocked(mintAndExchange).mockResolvedValue({ token: "tok" });
    cacheClientHoist.createEntry.mockResolvedValue("https://up/big?upload_id=AAANsU");
    cacheClientHoist.finalizeEntry.mockResolvedValue(undefined);

    await run();

    expect(putChunked).toHaveBeenCalledWith(
      "https://up/big?upload_id=AAANsU",
      expect.stringContaining("cache.tar.zst"),
      expect.any(Number),
      32 * 1024 * 1024,
    );
  });

  it("zero or negative upload-chunk-size falls back to DEFAULT_CHUNK_SIZE", async () => {
    fsStub.size = 200 * 1024 * 1024;
    inputs["upload-chunk-size"] = "0";
    vi.mocked(mintAndExchange).mockResolvedValue({ token: "tok" });
    cacheClientHoist.createEntry.mockResolvedValue("https://up/big?upload_id=AAANsU");
    cacheClientHoist.finalizeEntry.mockResolvedValue(undefined);

    await run();

    expect(putChunked).toHaveBeenCalledWith(
      "https://up/big?upload_id=AAANsU",
      expect.stringContaining("cache.tar.zst"),
      expect.any(Number),
      32 * 1024 * 1024,
    );
  });

  it("emits the five save-path info lines in order on the happy path", async () => {
    fsStub.size = 12 * 1024 * 1024; // 12 MiB compressed
    countingHoist.bytes = 45 * 1024 * 1024; // 45 MiB uncompressed
    timerHoist.queue.push(2100); // upload
    vi.mocked(mintAndExchange).mockResolvedValue({ token: "tok" });
    cacheClientHoist.createEntry.mockResolvedValue("https://up/abc");
    cacheClientHoist.finalizeEntry.mockResolvedValue(undefined);

    await run();

    const calls = vi.mocked(core.info).mock.calls.map((c) => c[0]);
    expect(calls).toContain("Cache version: computed-ver");
    expect(calls).toContain("Reserving cache for key: primary-key");
    expect(
      calls.find((s) => s.startsWith("Cache size:")),
    ).toBe("Cache size: 12.0 MB compressed (45.0 MB uncompressed, 3.8x)");
    expect(
      calls.find((s) => s.startsWith("Uploaded ")),
    ).toMatch(/Uploaded 12\.0 MB in 2\.1s \([\d.]+ MB\/s\)/);
    expect(calls).toContain("Cache saved successfully (key: primary-key)");
  });

  it("omits compression ratio when uncompressed < 1024", async () => {
    fsStub.size = 50; // 50 B compressed (frame overhead dominates)
    countingHoist.bytes = 12; // 12 B uncompressed
    timerHoist.queue.push(100);
    vi.mocked(mintAndExchange).mockResolvedValue({ token: "tok" });
    cacheClientHoist.createEntry.mockResolvedValue("https://up/abc");
    cacheClientHoist.finalizeEntry.mockResolvedValue(undefined);

    await run();

    const calls = vi.mocked(core.info).mock.calls.map((c) => c[0]);
    expect(
      calls.find((s) => s.startsWith("Cache size:")),
    ).toBe("Cache size: 50 B compressed (12 B uncompressed)");
  });

  it("ALREADY_EXISTS emits neither size nor upload nor saved-successfully lines", async () => {
    vi.mocked(mintAndExchange).mockResolvedValue({ token: "tok" });
    cacheClientHoist.createEntry.mockRejectedValue(
      new CacheClientError("exists", 409, "ALREADY_EXISTS", false),
    );

    await run();

    const calls = vi.mocked(core.info).mock.calls.map((c) => c[0]);
    expect(calls.find((s) => s.startsWith("Cache size:"))).toBeUndefined();
    expect(calls.find((s) => s.startsWith("Uploaded "))).toBeUndefined();
    expect(
      calls.find((s) => s.startsWith("Cache saved successfully")),
    ).toBeUndefined();
  });
});

describe("save main.run() — exact-hit skip", () => {
  it("skips the save entirely when the restore step recorded an exact primary-key hit", async () => {
    // restore recorded matchedKey == primaryKey ("primary-key").
    vi.mocked(core.getState).mockImplementation((name: string) =>
      name === STATE_CACHE_MATCHED_KEY ? "primary-key" : "",
    );

    await run();

    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining("not saving cache"),
    );
    // No auth, no archive, no reserve/upload/finalize — the whole step is skipped.
    expect(mintAndExchange).not.toHaveBeenCalled();
    expect(createTarStream).not.toHaveBeenCalled();
    expect(cacheClientHoist.createEntry).not.toHaveBeenCalled();
    expect(cacheClientHoist.finalizeEntry).not.toHaveBeenCalled();
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it("does NOT skip when the recorded matched key differs from the primary key (prefix / cross-ref hit)", async () => {
    vi.mocked(core.getState).mockImplementation((name: string) =>
      name === STATE_CACHE_MATCHED_KEY ? "older-key" : "",
    );
    vi.mocked(mintAndExchange).mockResolvedValue({ token: "tok" });
    cacheClientHoist.createEntry.mockResolvedValue("https://up/abc");
    cacheClientHoist.finalizeEntry.mockResolvedValue(undefined);

    await run();

    expect(cacheClientHoist.createEntry).toHaveBeenCalled();
  });
});
