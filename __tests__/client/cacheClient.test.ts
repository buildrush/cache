import { describe, it, expect, vi } from "vitest";
import { CacheClient, CacheClientError } from "../../src/client/cacheClient.js";

const baseUrl = "https://cache.buildrush.io";
const token = "fake-jwt";

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

function makeFetchMock(): FetchMock {
  return vi.fn<typeof fetch>();
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("CacheClient.createEntry", () => {
  it("posts JSON body and returns uploadUrl", async () => {
    const fetchMock = makeFetchMock();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { uploadUrl: "https://x/y" }),
    );
    const client = new CacheClient(baseUrl, token, { fetchImpl: fetchMock, baseDelayMs: 1 });
    const url = await client.createEntry({
      key: "k",
      version: "v",
      sizeBytes: 1024,
    });
    expect(url).toBe("https://x/y");
    expect(fetchMock).toHaveBeenCalledWith(
      `${baseUrl}/api/cache/entries`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          Authorization: "Bearer fake-jwt",
        }),
        body: JSON.stringify({ key: "k", version: "v", sizeBytes: 1024 }),
      }),
    );
    // No retry on success.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws CacheClientError on 409 ALREADY_EXISTS (retryable=false, no retry)", async () => {
    const fetchMock = makeFetchMock();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(409, {
        error: { code: "ALREADY_EXISTS", message: "exists" },
      }),
    );
    const client = new CacheClient(baseUrl, token, { fetchImpl: fetchMock, baseDelayMs: 1 });
    await expect(
      client.createEntry({ key: "k", version: "v", sizeBytes: 1024 }),
    ).rejects.toMatchObject({
      name: "CacheClientError",
      code: "ALREADY_EXISTS",
      status: 409,
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries on 5xx and bubbles after maxAttempts (3) with retryable=true", async () => {
    const fetchMock = makeFetchMock();
    // Same 503 every time → all 3 attempts fail.
    fetchMock.mockResolvedValue(
      jsonResponse(503, { error: { code: "UNAVAILABLE", message: "down" } }),
    );
    const client = new CacheClient(baseUrl, token, { fetchImpl: fetchMock, baseDelayMs: 1 });
    await expect(
      client.createEntry({ key: "k", version: "v", sizeBytes: 1024 }),
    ).rejects.toMatchObject({
      name: "CacheClientError",
      status: 503,
      retryable: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries on 5xx and eventually succeeds (2x 503 then 200)", async () => {
    const fetchMock = makeFetchMock();
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(503, { error: { code: "UNAVAILABLE", message: "down" } }),
      )
      .mockResolvedValueOnce(
        jsonResponse(503, { error: { code: "UNAVAILABLE", message: "down" } }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { uploadUrl: "https://x/y" }));
    const client = new CacheClient(baseUrl, token, { fetchImpl: fetchMock, baseDelayMs: 1 });
    const url = await client.createEntry({
      key: "k",
      version: "v",
      sizeBytes: 1024,
    });
    expect(url).toBe("https://x/y");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries on 429 and bubbles after maxAttempts with retryable=true", async () => {
    const fetchMock = makeFetchMock();
    fetchMock.mockResolvedValue(
      jsonResponse(429, { error: { code: "RATE_LIMITED", message: "slow" } }),
    );
    const client = new CacheClient(baseUrl, token, { fetchImpl: fetchMock, baseDelayMs: 1 });
    await expect(
      client.createEntry({ key: "k", version: "v", sizeBytes: 1024 }),
    ).rejects.toMatchObject({ status: 429, retryable: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries NETWORK_ERROR (retryable=true) up to maxAttempts on transport failure", async () => {
    const fetchMock = makeFetchMock();
    fetchMock.mockRejectedValue(new Error("ECONNRESET"));
    const client = new CacheClient(baseUrl, token, { fetchImpl: fetchMock, baseDelayMs: 1 });
    await expect(
      client.createEntry({ key: "k", version: "v", sizeBytes: 1 }),
    ).rejects.toMatchObject({
      name: "CacheClientError",
      code: "NETWORK_ERROR",
      retryable: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("throws PROTOCOL_ERROR when 200 body is missing uploadUrl (retryable=false, no retry)", async () => {
    const fetchMock = makeFetchMock();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    const client = new CacheClient(baseUrl, token, { fetchImpl: fetchMock, baseDelayMs: 1 });
    await expect(
      client.createEntry({ key: "k", version: "v", sizeBytes: 1 }),
    ).rejects.toMatchObject({
      code: "PROTOCOL_ERROR",
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("CacheClient.finalizeEntry", () => {
  it("posts JSON body and resolves on 204", async () => {
    const fetchMock = makeFetchMock();
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new CacheClient(baseUrl, token, { fetchImpl: fetchMock, baseDelayMs: 1 });
    await client.finalizeEntry({ key: "k", version: "v", sizeBytes: 1024 });
    expect(fetchMock).toHaveBeenCalledWith(
      `${baseUrl}/api/cache/entries/finalize`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ key: "k", version: "v", sizeBytes: 1024 }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws when finalize returns a non-204 status", async () => {
    const fetchMock = makeFetchMock();
    fetchMock.mockResolvedValue(
      jsonResponse(500, { error: { code: "INTERNAL", message: "x" } }),
    );
    const client = new CacheClient(baseUrl, token, { fetchImpl: fetchMock, baseDelayMs: 1 });
    await expect(
      client.finalizeEntry({ key: "k", version: "v", sizeBytes: 1024 }),
    ).rejects.toBeInstanceOf(CacheClientError);
    // 500 is retryable, so we expect 3 attempts.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry finalize on 429 — a quota rejection is terminal, not a rate limit", async () => {
    const fetchMock = makeFetchMock();
    fetchMock.mockResolvedValue(
      jsonResponse(429, {
        error: {
          code: "QUOTA_EXCEEDED",
          message: "per-repo overcommit limit exceeded",
        },
      }),
    );
    const client = new CacheClient(baseUrl, token, {
      fetchImpl: fetchMock,
      baseDelayMs: 1,
    });
    await expect(
      client.finalizeEntry({ key: "k", version: "v", sizeBytes: 1024 }),
    ).rejects.toMatchObject({ status: 429, code: "QUOTA_EXCEEDED" });
    // The cache service rate-limits only createEntry; a finalize 429 is the
    // per-repo/per-installation quota rejection, which retrying cannot clear.
    // Retrying would also let the server's compensation delete the reservation
    // and turn the retry into a misleading 404, so finalize must not retry 429.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("CacheClient.lookupEntry", () => {
  it("returns null on miss (200 {})", async () => {
    const fetchMock = makeFetchMock();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    const client = new CacheClient(baseUrl, token, { fetchImpl: fetchMock, baseDelayMs: 1 });
    const result = await client.lookupEntry({
      key: "k",
      version: "v",
      restoreKeys: [],
    });
    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns the hit on 200 {downloadUrl, matchedKey}", async () => {
    const fetchMock = makeFetchMock();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { downloadUrl: "https://x/y", matchedKey: "k" }),
    );
    const client = new CacheClient(baseUrl, token, { fetchImpl: fetchMock, baseDelayMs: 1 });
    const result = await client.lookupEntry({
      key: "k",
      version: "v",
      restoreKeys: ["k1"],
    });
    expect(result).toEqual({ downloadUrl: "https://x/y", matchedKey: "k" });
  });

  it("posts restoreKeys array verbatim in the body", async () => {
    const fetchMock = makeFetchMock();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    const client = new CacheClient(baseUrl, token, { fetchImpl: fetchMock, baseDelayMs: 1 });
    await client.lookupEntry({
      key: "primary",
      version: "ver",
      restoreKeys: ["fallback-1", "fallback-2"],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `${baseUrl}/api/cache/entries/lookup`,
      expect.objectContaining({
        body: JSON.stringify({
          key: "primary",
          version: "ver",
          restoreKeys: ["fallback-1", "fallback-2"],
        }),
      }),
    );
  });
});

describe("CacheClient.reportTelemetry", () => {
  const telemetry = {
    key: "deps-Linux-x64",
    version: "v1",
    matchedKey: "deps-Linux-",
    clientDurationMs: 8421,
    clientBytes: 734003200,
    clientThroughput: 87187000,
    decompressMs: 1320,
    outcome: "ok" as const,
  };

  it("posts the telemetry body + bearer with a timeout signal and resolves on 204", async () => {
    const fetchMock = makeFetchMock();
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new CacheClient(baseUrl, token, { fetchImpl: fetchMock, baseDelayMs: 1 });
    await client.reportTelemetry(telemetry);
    expect(fetchMock).toHaveBeenCalledWith(
      `${baseUrl}/api/cache/telemetry`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer fake-jwt" }),
        body: JSON.stringify(telemetry),
        // Best-effort telemetry is hard-bounded by a timeout so a hung
        // endpoint can never stall the cache step.
        signal: expect.any(AbortSignal),
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws a non-retryable CacheClientError on 400 (single attempt)", async () => {
    const fetchMock = makeFetchMock();
    fetchMock.mockResolvedValue(
      jsonResponse(400, { error: { code: "VALIDATION_ERROR", message: "bad" } }),
    );
    const client = new CacheClient(baseUrl, token, { fetchImpl: fetchMock, baseDelayMs: 1 });
    await expect(client.reportTelemetry(telemetry)).rejects.toMatchObject({
      name: "CacheClientError",
      status: 400,
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry on 5xx — single attempt, unlike the other endpoints", async () => {
    const fetchMock = makeFetchMock();
    fetchMock.mockResolvedValue(
      jsonResponse(503, { error: { code: "UNAVAILABLE", message: "down" } }),
    );
    const client = new CacheClient(baseUrl, token, { fetchImpl: fetchMock, baseDelayMs: 1 });
    await expect(client.reportTelemetry(telemetry)).rejects.toMatchObject({
      status: 503,
    });
    // Telemetry is best-effort: a single attempt, no retry budget spent.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("aborts a hung telemetry POST after the timeout and does not retry", async () => {
    const fetchMock = makeFetchMock();
    // Simulate a server that accepts the socket then stalls: the fetch only
    // settles when its AbortSignal fires.
    fetchMock.mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = (init as RequestInit | undefined)?.signal;
          signal?.addEventListener("abort", () =>
            reject(new DOMException("timed out", "TimeoutError")),
          );
        }),
    );
    const client = new CacheClient(baseUrl, token, {
      fetchImpl: fetchMock,
      telemetryTimeoutMs: 20,
    });
    await expect(client.reportTelemetry(telemetry)).rejects.toMatchObject({
      name: "CacheClientError",
      code: "NETWORK_ERROR",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
