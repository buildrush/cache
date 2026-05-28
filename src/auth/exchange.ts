import * as core from "@actions/core";
import { ExchangeError } from "./types.js";
import type { ExchangeResult } from "./types.js";

const DEFAULT_AUDIENCE = "https://cache.buildrush.io";
const DEFAULT_EXCHANGE_URL = "https://cache.buildrush.io";
const EXCHANGE_PATH = "/api/cache/auth/exchange";

export interface MintAndExchangeOptions {
  exchangeBaseUrl?: string;
  audience?: string;
  /** Optional fetch override for tests. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

export async function mintAndExchange(
  opts: MintAndExchangeOptions = {}
): Promise<ExchangeResult> {
  const audience = opts.audience ?? DEFAULT_AUDIENCE;
  const baseUrl = opts.exchangeBaseUrl ?? DEFAULT_EXCHANGE_URL;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) {
    throw new ExchangeError(
      "oidc-mint-failed",
      "Missing OIDC token request env vars — workflow needs 'permissions: id-token: write'"
    );
  }

  const jwt = await mintOidcToken(
    requestUrl,
    requestToken,
    audience,
    fetchImpl
  );
  return await exchangeToken(baseUrl, audience, jwt, fetchImpl);
}

async function mintOidcToken(
  requestUrl: string,
  requestToken: string,
  audience: string,
  fetchImpl: typeof fetch
): Promise<string> {
  const separator = requestUrl.includes("?") ? "&" : "?";
  const mintUrl = `${requestUrl}${separator}audience=${encodeURIComponent(audience)}`;

  let resp: Response;
  try {
    resp = await fetchImpl(mintUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${requestToken}`,
      },
    });
  } catch (err) {
    throw new ExchangeError(
      "oidc-mint-failed",
      `OIDC mint failed: ${(err as Error).message}`
    );
  }

  if (resp.status !== 200) {
    throw new ExchangeError(
      "oidc-mint-failed",
      `OIDC mint returned status ${resp.status}`
    );
  }

  let body: unknown;
  try {
    body = await resp.json();
  } catch (err) {
    throw new ExchangeError(
      "oidc-mint-failed",
      `OIDC mint response not JSON: ${(err as Error).message}`
    );
  }

  const value = extractMintValue(body);
  if (!value) {
    throw new ExchangeError(
      "oidc-mint-failed",
      "OIDC mint response missing 'value' field"
    );
  }
  return value;
}

function extractMintValue(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const candidate = (body as { value?: unknown }).value;
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : undefined;
}

function buildExchangeUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.pathname = EXCHANGE_PATH;
  return url.toString();
}

function errorForStatus(code: number): ExchangeError {
  if (code === 401) return new ExchangeError("oidc-rejected");
  if (code === 403) return new ExchangeError("installation-not-enabled");
  if (code === 429) return new ExchangeError("rate-limited");
  if (code >= 500 && code < 600) return new ExchangeError("service-unavailable");
  return new ExchangeError(
    "service-unavailable",
    `Unexpected status ${code}`
  );
}

async function exchangeToken(
  baseUrl: string,
  audience: string,
  jwt: string,
  fetchImpl: typeof fetch
): Promise<ExchangeResult> {
  const exchangeUrl = buildExchangeUrl(baseUrl);

  let resp: Response;
  try {
    resp = await fetchImpl(exchangeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({ audience }),
    });
  } catch (err) {
    throw new ExchangeError(
      "network-error",
      `Exchange network error: ${(err as Error).message}`
    );
  }

  if (resp.status !== 200) {
    throw errorForStatus(resp.status);
  }

  let body: unknown;
  try {
    body = await resp.json();
  } catch (err) {
    throw new ExchangeError(
      "service-unavailable",
      `Exchange response not JSON: ${(err as Error).message}`
    );
  }

  const token = extractExchangeToken(body);
  if (!token) {
    throw new ExchangeError(
      "service-unavailable",
      "Exchange returned malformed body"
    );
  }

  // Mask the cache-service JWT in subsequent log lines. Any accidental
  // log call (warning, info, notice) that prints this value will be
  // rewritten to *** by the runner's secret-scanning layer.
  core.setSecret(token);

  return { token };
}

function extractExchangeToken(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const candidate = (body as { token?: unknown }).token;
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : undefined;
}
