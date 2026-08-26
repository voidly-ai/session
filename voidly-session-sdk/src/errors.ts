
export class SessionCryptoUnavailableError extends Error {
  readonly code = "session_crypto_unavailable";
  constructor(message: string) {
    super(message);
    this.name = "SessionCryptoUnavailableError";
  }
}

export class SessionUsageError extends Error {
  readonly code = "session_usage_error";
  constructor(message: string) {
    super(message);
    this.name = "SessionUsageError";
  }
}

export class SessionTransportError extends Error {
  readonly code = "session_transport_error";
  readonly status: number;
  readonly body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = "SessionTransportError";
    this.status = status;
    this.body = body;
  }
}
