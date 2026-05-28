import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as core from "@actions/core";
import { mintAndExchange } from "../../src/auth/exchange.js";
import { ExchangeError } from "../../src/auth/types.js";

vi.mock("@actions/core", async () => {
  const actual =
    await vi.importActual<typeof import("@actions/core")>("@actions/core");
  return { ...actual, setSecret: vi.fn() };
});

const originalEnv = { ...process.env };

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

function emptyResponse(status: number): Response {
  return new Response(null, { status });
}

function mockMint(fetchMock: FetchMock, jwt = "minted-jwt"): void {
  fetchMock.mockResolvedValueOnce(jsonResponse(200, { value: jwt }));
}

function mockExchangeSuccess(
  fetchMock: FetchMock,
  token = "exchange-token"
): void {
  fetchMock.mockResolvedValueOnce(jsonResponse(200, { token }));
}

beforeEach(() => {
  vi.resetAllMocks();
  process.env.ACTIONS_ID_TOKEN_REQUEST_URL = "https://token.example/?";
  process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = "ghs_fake";
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("mintAndExchange", () => {
  it("returns { token } on 200 success", async () => {
    const fetchMock = makeFetchMock();
    mockMint(fetchMock);
    mockExchangeSuccess(fetchMock, "fresh-cache-token");

    const result = await mintAndExchange({ fetchImpl: fetchMock });

    expect(result).toEqual({ token: "fresh-cache-token" });
  });

  it("registers the exchanged token as a runner secret", async () => {
    const fetchMock = makeFetchMock();
    mockMint(fetchMock);
    mockExchangeSuccess(fetchMock, "very-secret-cache-token");

    await mintAndExchange({ fetchImpl: fetchMock });

    expect(core.setSecret).toHaveBeenCalledWith("very-secret-cache-token");
  });

  it("uses default exchange URL when none provided", async () => {
    const fetchMock = makeFetchMock();
    mockMint(fetchMock);
    mockExchangeSuccess(fetchMock);

    await mintAndExchange({ fetchImpl: fetchMock });

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://cache.buildrush.io/api/cache/auth/exchange",
      expect.any(Object)
    );
  });

  it("uses provided exchangeBaseUrl override", async () => {
    const fetchMock = makeFetchMock();
    mockMint(fetchMock);
    mockExchangeSuccess(fetchMock);

    await mintAndExchange({
      fetchImpl: fetchMock,
      exchangeBaseUrl: "https://cache.staging.example",
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://cache.staging.example/api/cache/auth/exchange",
      expect.any(Object)
    );
  });

  it("preserves query string from exchangeBaseUrl when constructing exchange URL", async () => {
    const fetchMock = makeFetchMock();
    mockMint(fetchMock);
    mockExchangeSuccess(fetchMock);

    await mintAndExchange({
      fetchImpl: fetchMock,
      exchangeBaseUrl: "https://cache.buildrush.dev?force-status=401",
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://cache.buildrush.dev/api/cache/auth/exchange?force-status=401",
      expect.any(Object)
    );
  });

  it("sends exchange body as camelCase JSON { audience }", async () => {
    const fetchMock = makeFetchMock();
    mockMint(fetchMock);
    mockExchangeSuccess(fetchMock);

    await mintAndExchange({
      fetchImpl: fetchMock,
      audience: "https://cache.buildrush.dev",
    });

    const exchangeCall = fetchMock.mock.calls[1];
    expect(exchangeCall).toBeDefined();
    const init = exchangeCall?.[1];
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(
      JSON.stringify({ audience: "https://cache.buildrush.dev" })
    );
    expect(init?.headers).toEqual(
      expect.objectContaining({
        "Content-Type": "application/json",
        Authorization: "Bearer minted-jwt",
      })
    );
  });

  it("requests OIDC token with the default cache.buildrush.io audience when none provided", async () => {
    const fetchMock = makeFetchMock();
    mockMint(fetchMock);
    mockExchangeSuccess(fetchMock);

    await mintAndExchange({ fetchImpl: fetchMock });

    const mintCall = fetchMock.mock.calls[0];
    expect(mintCall).toBeDefined();
    expect(mintCall?.[0]).toEqual(
      expect.stringContaining("audience=https%3A%2F%2Fcache.buildrush.io")
    );
    expect(mintCall?.[1]?.headers).toEqual(
      expect.objectContaining({ Authorization: "Bearer ghs_fake" })
    );
  });

  it("uses the provided audience verbatim in the mint URL", async () => {
    const fetchMock = makeFetchMock();
    mockMint(fetchMock);
    mockExchangeSuccess(fetchMock);

    await mintAndExchange({
      fetchImpl: fetchMock,
      audience: "https://cache.buildrush.dev",
    });

    const mintCall = fetchMock.mock.calls[0];
    expect(mintCall).toBeDefined();
    expect(mintCall?.[0]).toEqual(
      expect.stringContaining("audience=https%3A%2F%2Fcache.buildrush.dev")
    );
  });

  it("throws oidc-mint-failed when token-request URL is missing", async () => {
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    const fetchMock = makeFetchMock();
    await expect(
      mintAndExchange({ fetchImpl: fetchMock })
    ).rejects.toMatchObject({
      reason: "oidc-mint-failed",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws oidc-mint-failed when token-request token is missing", async () => {
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    const fetchMock = makeFetchMock();
    await expect(
      mintAndExchange({ fetchImpl: fetchMock })
    ).rejects.toMatchObject({
      reason: "oidc-mint-failed",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws oidc-mint-failed when mint returns non-200", async () => {
    const fetchMock = makeFetchMock();
    fetchMock.mockResolvedValueOnce(emptyResponse(500));
    await expect(
      mintAndExchange({ fetchImpl: fetchMock })
    ).rejects.toMatchObject({
      reason: "oidc-mint-failed",
    });
  });

  it("throws oidc-mint-failed when mint throws", async () => {
    const fetchMock = makeFetchMock();
    fetchMock.mockRejectedValueOnce(new Error("boom"));
    await expect(
      mintAndExchange({ fetchImpl: fetchMock })
    ).rejects.toMatchObject({
      reason: "oidc-mint-failed",
    });
  });

  it.each([
    [401, "oidc-rejected"],
    [403, "installation-not-enabled"],
    [429, "rate-limited"],
    [500, "service-unavailable"],
    [502, "service-unavailable"],
    [503, "service-unavailable"],
  ])(
    "maps exchange status %d to reason %s",
    async (status, reason) => {
      const fetchMock = makeFetchMock();
      mockMint(fetchMock);
      fetchMock.mockResolvedValueOnce(emptyResponse(status));
      await expect(
        mintAndExchange({ fetchImpl: fetchMock })
      ).rejects.toMatchObject({ reason });
    }
  );

  it("throws service-unavailable on unmapped exchange status (e.g. 418)", async () => {
    const fetchMock = makeFetchMock();
    mockMint(fetchMock);
    fetchMock.mockResolvedValueOnce(emptyResponse(418));
    await expect(
      mintAndExchange({ fetchImpl: fetchMock })
    ).rejects.toMatchObject({ reason: "service-unavailable" });
  });

  it("maps 404 to service-unavailable", async () => {
    const fetchMock = makeFetchMock();
    mockMint(fetchMock);
    fetchMock.mockResolvedValueOnce(emptyResponse(404));
    await expect(
      mintAndExchange({ fetchImpl: fetchMock })
    ).rejects.toMatchObject({ reason: "service-unavailable" });
  });

  it("throws service-unavailable when 200 body is missing the token field", async () => {
    const fetchMock = makeFetchMock();
    mockMint(fetchMock);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { somethingElse: 1 }));
    await expect(
      mintAndExchange({ fetchImpl: fetchMock })
    ).rejects.toMatchObject({ reason: "service-unavailable" });
  });

  it("throws service-unavailable when 200 body has empty token", async () => {
    const fetchMock = makeFetchMock();
    mockMint(fetchMock);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { token: "" }));
    await expect(
      mintAndExchange({ fetchImpl: fetchMock })
    ).rejects.toMatchObject({ reason: "service-unavailable" });
  });

  it("throws network-error when exchange POST rejects with a non-Response error", async () => {
    const fetchMock = makeFetchMock();
    mockMint(fetchMock);
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(
      mintAndExchange({ fetchImpl: fetchMock })
    ).rejects.toMatchObject({ reason: "network-error" });
  });

  it("ExchangeError instances are thrown (not wrapped Error)", async () => {
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    const fetchMock = makeFetchMock();
    await expect(
      mintAndExchange({ fetchImpl: fetchMock })
    ).rejects.toBeInstanceOf(ExchangeError);
  });
});
