import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { chooseUploadMode, putSingleShot, putChunked } from "../../src/transport/upload.js";
import { TransportError } from "../../src/transport/errors.js";

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

function makeFetchMock(): FetchMock {
  return vi.fn<typeof fetch>();
}

function emptyResponse(status: number, statusText = ""): Response {
  return new Response(null, { status, statusText });
}

function resumeResponse(persistedEnd: number): Response {
  return new Response(null, {
    status: 308,
    headers: { Range: `bytes=0-${persistedEnd}` },
  });
}

let tmpDir: string;
beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "br-upload-test-"));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeTempFile(name: string, body: Buffer | string): Promise<string> {
  const p = path.join(tmpDir, name);
  await fs.writeFile(p, body);
  return p;
}

async function readFetchBody(body: BodyInit | null | undefined): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

describe("putSingleShot", () => {
  it("streams the file at sourcePath as the PUT body with matching Content-Length", async () => {
    const fetchMock = makeFetchMock();
    fetchMock.mockResolvedValueOnce(emptyResponse(200));
    const payload = Buffer.from("hello world", "utf8");
    const src = await writeTempFile("payload.bin", payload);

    await putSingleShot("https://upload.example/abc", src, payload.byteLength, {
      fetchImpl: fetchMock,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toBe("https://upload.example/abc");
    const init = call?.[1];
    expect(init?.method).toBe("PUT");
    expect(init?.headers).toEqual(
      expect.objectContaining({ "Content-Length": String(payload.byteLength) }),
    );
    const sent = await readFetchBody(init?.body);
    expect(sent.equals(payload)).toBe(true);
  });

  it("accepts 201 and 204 as success", async () => {
    const src = await writeTempFile("p.bin", "a");
    const fetchMock = makeFetchMock();
    fetchMock.mockResolvedValueOnce(emptyResponse(201));
    await putSingleShot("https://x", src, 1, { fetchImpl: fetchMock });
    fetchMock.mockResolvedValueOnce(emptyResponse(204));
    await putSingleShot("https://x", src, 1, { fetchImpl: fetchMock });
  });

  it("throws TransportError(status: 403, retryable: false) on 4xx", async () => {
    const src = await writeTempFile("p.bin", "a");
    const fetchMock = makeFetchMock();
    fetchMock.mockResolvedValueOnce(
      new Response("forbidden", { status: 403, statusText: "Forbidden" }),
    );
    await expect(
      putSingleShot("https://x", src, 1, { fetchImpl: fetchMock }),
    ).rejects.toBeInstanceOf(TransportError);
    fetchMock.mockResolvedValueOnce(
      new Response("forbidden", { status: 403, statusText: "Forbidden" }),
    );
    await expect(
      putSingleShot("https://x", src, 1, { fetchImpl: fetchMock }),
    ).rejects.toMatchObject({
      status: 403,
      retryable: false,
    });
  });

  it("throws TransportError(status: 503, retryable: true) on 5xx", async () => {
    const src = await writeTempFile("p.bin", "a");
    const fetchMock = makeFetchMock();
    fetchMock.mockResolvedValueOnce(
      new Response("boom", { status: 503, statusText: "Service Unavailable" }),
    );
    await expect(
      putSingleShot("https://x", src, 1, { fetchImpl: fetchMock, maxAttempts: 1 }),
    ).rejects.toMatchObject({
      name: "TransportError",
      status: 503,
      retryable: true,
    });
  });

  it("retries on 5xx and eventually succeeds (2x 503 then 200)", async () => {
    const fetchMock = makeFetchMock();
    fetchMock
      .mockResolvedValueOnce(emptyResponse(503))
      .mockResolvedValueOnce(emptyResponse(503))
      .mockResolvedValueOnce(emptyResponse(200));
    const src = await writeTempFile("p.bin", "hello");
    await putSingleShot("https://x", src, 5, {
      fetchImpl: fetchMock,
      baseDelayMs: 1,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries on 5xx and bubbles after maxAttempts with retryable=true", async () => {
    const fetchMock = makeFetchMock();
    fetchMock.mockResolvedValue(emptyResponse(503));
    const src = await writeTempFile("p.bin", "hello");
    await expect(
      putSingleShot("https://x", src, 5, {
        fetchImpl: fetchMock,
        baseDelayMs: 1,
      }),
    ).rejects.toMatchObject({
      name: "TransportError",
      status: 503,
      retryable: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry on 4xx (single fetch call)", async () => {
    const fetchMock = makeFetchMock();
    fetchMock.mockResolvedValueOnce(emptyResponse(403));
    const src = await writeTempFile("p.bin", "hello");
    await expect(
      putSingleShot("https://x", src, 5, {
        fetchImpl: fetchMock,
        baseDelayMs: 1,
      }),
    ).rejects.toMatchObject({
      name: "TransportError",
      status: 403,
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries on network errors and eventually succeeds", async () => {
    const fetchMock = makeFetchMock();
    fetchMock
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockRejectedValueOnce(new Error("ETIMEDOUT"))
      .mockResolvedValueOnce(emptyResponse(200));
    const src = await writeTempFile("p.bin", "hello");
    await putSingleShot("https://x", src, 5, {
      fetchImpl: fetchMock,
      baseDelayMs: 1,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("putChunked", () => {
  it("issues 3 PUTs at bytes 0-3/10, 4-7/10, 8-9/10 with 308,308,200; streams correct chunk bytes", async () => {
    const fetchMock = makeFetchMock();
    fetchMock
      .mockResolvedValueOnce(resumeResponse(3))
      .mockResolvedValueOnce(resumeResponse(7))
      .mockResolvedValueOnce(emptyResponse(200));

    const payload = Buffer.from("0123456789", "utf8");
    const src = await writeTempFile("p.bin", payload);

    await putChunked("https://session.example/upload", src, payload.byteLength, 4, {
      fetchImpl: fetchMock,
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const ranges = fetchMock.mock.calls.map(
      (c) => (c[1]?.headers as Record<string, string>)["Content-Range"],
    );
    expect(ranges).toEqual(["bytes 0-3/10", "bytes 4-7/10", "bytes 8-9/10"]);
    const lengths = fetchMock.mock.calls.map(
      (c) => (c[1]?.headers as Record<string, string>)["Content-Length"],
    );
    expect(lengths).toEqual(["4", "4", "2"]);
    // Each chunk's body bytes must match the corresponding slice of the source.
    const bodies = await Promise.all(
      fetchMock.mock.calls.map((c) => readFetchBody(c[1]?.body)),
    );
    expect(bodies[0]!.equals(payload.subarray(0, 4))).toBe(true);
    expect(bodies[1]!.equals(payload.subarray(4, 8))).toBe(true);
    expect(bodies[2]!.equals(payload.subarray(8, 10))).toBe(true);
  });

  it("accepts 201 on the final chunk as well as 200", async () => {
    const fetchMock = makeFetchMock();
    fetchMock
      .mockResolvedValueOnce(resumeResponse(3))
      .mockResolvedValueOnce(resumeResponse(7))
      .mockResolvedValueOnce(emptyResponse(201));
    const src = await writeTempFile("p.bin", "0123456789");
    await putChunked("https://session", src, 10, 4, { fetchImpl: fetchMock });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("throws TransportError on intermediate chunk 5xx (no later chunks attempted)", async () => {
    const fetchMock = makeFetchMock();
    fetchMock
      .mockResolvedValueOnce(resumeResponse(3))
      .mockResolvedValueOnce(
        new Response("nope", { status: 500, statusText: "Internal" }),
      );
    const src = await writeTempFile("p.bin", "0123456789");
    await expect(
      putChunked("https://session", src, 10, 4, {
        fetchImpl: fetchMock,
        baseDelayMs: 1,
        maxAttempts: 1,
      }),
    ).rejects.toMatchObject({
      name: "TransportError",
      status: 500,
      retryable: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws TransportError on final chunk 308 (mistake for completion)", async () => {
    const fetchMock = makeFetchMock();
    fetchMock
      .mockResolvedValueOnce(resumeResponse(3))
      .mockResolvedValueOnce(resumeResponse(7))
      .mockResolvedValueOnce(emptyResponse(308));
    const src = await writeTempFile("p.bin", "0123456789");
    await expect(
      putChunked("https://session", src, 10, 4, { fetchImpl: fetchMock }),
    ).rejects.toMatchObject({ name: "TransportError", status: 308 });
  });

  it("throws TransportError(retryable: true) when 308 has no Range header", async () => {
    const fetchMock = makeFetchMock();
    fetchMock.mockResolvedValueOnce(emptyResponse(308));
    const src = await writeTempFile("p.bin", "0123456789");
    await expect(
      putChunked("https://session", src, 10, 4, {
        fetchImpl: fetchMock,
        baseDelayMs: 1,
        maxAttempts: 1,
      }),
    ).rejects.toMatchObject({
      name: "TransportError",
      status: 308,
      retryable: true,
    });
  });

  it("throws TransportError when 308 Range reports partial persistence", async () => {
    const fetchMock = makeFetchMock();
    fetchMock.mockResolvedValueOnce(resumeResponse(2));
    const src = await writeTempFile("p.bin", "0123456789");
    await expect(
      putChunked("https://session", src, 10, 4, {
        fetchImpl: fetchMock,
        baseDelayMs: 1,
        maxAttempts: 1,
      }),
    ).rejects.toMatchObject({
      name: "TransportError",
      status: 308,
      retryable: true,
    });
  });

  it("throws TransportError on unparseable Range header", async () => {
    const fetchMock = makeFetchMock();
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 308, headers: { Range: "weird-format" } }),
    );
    const src = await writeTempFile("p.bin", "0123456789");
    await expect(
      putChunked("https://session", src, 10, 4, {
        fetchImpl: fetchMock,
        baseDelayMs: 1,
        maxAttempts: 1,
      }),
    ).rejects.toMatchObject({ name: "TransportError", status: 308 });
  });

  it("single PUT when total == chunkSize: range bytes 0-(total-1)/total", async () => {
    const fetchMock = makeFetchMock();
    fetchMock.mockResolvedValueOnce(emptyResponse(200));
    const src = await writeTempFile("p.bin", "0123456789");
    await putChunked("https://session", src, 10, 10, { fetchImpl: fetchMock });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers["Content-Range"]).toBe("bytes 0-9/10");
    expect(headers["Content-Length"]).toBe("10");
  });

  it("retries an individual chunk on 5xx and completes the upload (chunk 2 fails 2x then 308)", async () => {
    const fetchMock = makeFetchMock();
    // Chunk 1 (0-3): 308. Chunk 2 (4-7): 503, 503, 308. Chunk 3 (8-9): 200.
    fetchMock
      .mockResolvedValueOnce(resumeResponse(3))
      .mockResolvedValueOnce(emptyResponse(503))
      .mockResolvedValueOnce(emptyResponse(503))
      .mockResolvedValueOnce(resumeResponse(7))
      .mockResolvedValueOnce(emptyResponse(200));
    const src = await writeTempFile("p.bin", "0123456789");
    await putChunked("https://session", src, 10, 4, {
      fetchImpl: fetchMock,
      baseDelayMs: 1,
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("bubbles a chunk failure after retry exhaustion; later chunks not attempted", async () => {
    const fetchMock = makeFetchMock();
    fetchMock
      .mockResolvedValueOnce(resumeResponse(3))    // chunk 1 ok
      .mockResolvedValueOnce(emptyResponse(503))    // chunk 2 attempt 1
      .mockResolvedValueOnce(emptyResponse(503))    // chunk 2 attempt 2
      .mockResolvedValueOnce(emptyResponse(503));   // chunk 2 attempt 3
    const src = await writeTempFile("p.bin", "0123456789");
    await expect(
      putChunked("https://session", src, 10, 4, {
        fetchImpl: fetchMock,
        baseDelayMs: 1,
      }),
    ).rejects.toMatchObject({
      name: "TransportError",
      status: 503,
      retryable: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("re-streams chunk bytes correctly on retry (same Content-Range, same body slice)", async () => {
    const fetchMock = makeFetchMock();
    // Chunk 1 (0-3): 503 once, then 308. Chunk 2 (4-7): 308. Chunk 3 (8-9): 200 (final).
    fetchMock
      .mockResolvedValueOnce(emptyResponse(503))
      .mockResolvedValueOnce(resumeResponse(3))
      .mockResolvedValueOnce(resumeResponse(7))
      .mockResolvedValueOnce(emptyResponse(200));
    const payload = Buffer.from("0123456789", "utf8");
    const src = await writeTempFile("p.bin", payload);
    await putChunked("https://session", src, payload.byteLength, 4, {
      fetchImpl: fetchMock,
      baseDelayMs: 1,
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const calls = fetchMock.mock.calls;
    // Attempts 1 and 2 are both chunk 0-3, same Content-Range and same bytes.
    const headers0 = calls[0]?.[1]?.headers as Record<string, string>;
    const headers1 = calls[1]?.[1]?.headers as Record<string, string>;
    expect(headers0["Content-Range"]).toBe("bytes 0-3/10");
    expect(headers1["Content-Range"]).toBe("bytes 0-3/10");
    const body0 = await readFetchBody(calls[0]?.[1]?.body);
    const body1 = await readFetchBody(calls[1]?.[1]?.body);
    expect(body0.equals(payload.subarray(0, 4))).toBe(true);
    expect(body1.equals(payload.subarray(0, 4))).toBe(true);
  });
});

describe("chooseUploadMode", () => {
  it("returns chunked for GCS resumable session URIs", () => {
    expect(
      chooseUploadMode(
        "https://storage.googleapis.com/upload/storage/v1/b/buildrush-cache/o?name=foo&upload_id=AAANsU",
      ),
    ).toBe("chunked");
  });

  it("returns chunked when upload_id is the first query param", () => {
    expect(chooseUploadMode("https://example.com/o?upload_id=x&name=foo")).toBe("chunked");
  });

  it("returns single-shot for V4-signed PUT URLs", () => {
    expect(
      chooseUploadMode(
        "https://storage.googleapis.com/buildrush-cache/abc?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Credential=svc&X-Goog-Signature=deadbeef",
      ),
    ).toBe("single-shot");
  });

  it("returns single-shot for URLs without any query string", () => {
    expect(chooseUploadMode("https://example.com/path")).toBe("single-shot");
  });

  it("does not match upload_id appearing in a path segment", () => {
    expect(chooseUploadMode("https://example.com/upload_id-fake/object")).toBe("single-shot");
  });
});
