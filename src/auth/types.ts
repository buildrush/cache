export type ReasonCode =
  | "oidc-mint-failed"
  | "network-error"
  | "oidc-rejected"
  | "installation-not-enabled"
  | "rate-limited"
  | "service-unavailable";

export type FallbackMode = "github" | "skip" | "fail";

export interface ExchangeResult {
  token: string;
}

export class ExchangeError extends Error {
  constructor(public readonly reason: ReasonCode, message?: string) {
    super(message ?? reason);
    this.name = "ExchangeError";
  }
}

export function isFallbackMode(value: string): value is FallbackMode {
  return value === "github" || value === "skip" || value === "fail";
}
