import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { downloadToFile } from "../../src/transport/download.js";
import { TransportError } from "../../src/transport/errors.js";

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

function makeFetchMock(): FetchMock {
  return vi.fn<typeof fetch>();
}

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "br-dl-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("downloadToFile", () => {
  it("streams a successful GET body to disk byte-for-byte", async () => {
    const payload = Buffer.alloc(2048);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 17) & 0xff;
    const fetchMock = makeFetchMock();
    fetchMock.mockResolvedValueOnce(
      new Response(payload, {
        status: 200,
        headers: { "Content-Length": String(payload.byteLength) },
      }),
    );

    const dest = path.join(dir, "archive.bin");
    await downloadToFile("https://download.example/abc", dest, {
      fetchImpl: fetchMock,
    });

    const written = await fs.readFile(dest);
    expect(written.equals(payload)).toBe(true);

    // GET was issued to the URL.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://download.example/abc");
  });

  it("writes a 0-byte file when the response body is empty", async () => {
    const fetchMock = makeFetchMock();
    fetchMock.mockResolvedValueOnce(
      new Response(new Uint8Array(0), { status: 200 }),
    );
    const dest = path.join(dir, "empty.bin");
    await downloadToFile("https://x", dest, { fetchImpl: fetchMock });
    const stat = await fs.stat(dest);
    expect(stat.size).toBe(0);
  });

  it("throws TransportError(retryable: false) on 404 with no retry", async () => {
    const fetchMock = makeFetchMock();
    fetchMock.mockResolvedValueOnce(
      new Response("nope", { status: 404, statusText: "Not Found" }),
    );
    const destPath = path.join(dir, "out.bin");
    const err = await downloadToFile("https://x/dl", destPath, {
      fetchImpl: fetchMock,
      baseDelayMs: 1,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect(err).toMatchObject({
      status: 404,
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws TransportError(retryable: true) on 503 after maxAttempts retries", async () => {
    const fetchMock = makeFetchMock();
    fetchMock.mockResolvedValue(
      new Response("boom", { status: 503, statusText: "Service Unavailable" }),
    );
    const destPath = path.join(dir, "out.bin");
    await expect(
      downloadToFile("https://x/dl", destPath, {
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

  it("retries on 5xx and writes the eventual 200 body (proves truncation between attempts)", async () => {
    const fetchMock = makeFetchMock();
    fetchMock
      .mockResolvedValueOnce(new Response("FIRST", { status: 503 }))
      .mockResolvedValueOnce(new Response("RETRY-OK", { status: 200 }));
    const destPath = path.join(dir, "out.bin");
    await downloadToFile("https://x/dl", destPath, {
      fetchImpl: fetchMock,
      baseDelayMs: 1,
    });
    const written = await fs.readFile(destPath);
    expect(written.toString("utf8")).toBe("RETRY-OK");
  });

  it("retries on network errors and writes the body when fetch eventually resolves", async () => {
    const fetchMock = makeFetchMock();
    fetchMock
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(new Response("OK", { status: 200 }));
    const destPath = path.join(dir, "out.bin");
    await downloadToFile("https://x/dl", destPath, {
      fetchImpl: fetchMock,
      baseDelayMs: 1,
    });
    const written = await fs.readFile(destPath);
    expect(written.toString("utf8")).toBe("OK");
  });
});
