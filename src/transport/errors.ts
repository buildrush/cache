// Shared error type for the transport layer (upload + download). Carries
// status + retryable so the withRetry layer can decide per-attempt without
// inspecting message strings.

export class TransportError extends Error {
  public override readonly name = "TransportError";
  constructor(
    message: string,
    /** HTTP status code, or 0 for network/transport errors before a response. */
    public readonly status: number,
    public readonly retryable: boolean,
  ) {
    super(message);
  }
}
