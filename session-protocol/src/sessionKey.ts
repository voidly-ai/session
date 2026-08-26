
const REDACTED = "[redacted:session-key]";

const SESSION_KEY_LENGTH = 32;

const INSPECT_CUSTOM: unique symbol = Symbol.for("nodejs.util.inspect.custom");

class SessionKeyHandle {
  readonly #isSessionKey = true;

  toJSON(): string {
    return REDACTED;
  }

  toString(): string {
    return REDACTED;
  }

  [INSPECT_CUSTOM](): string {
    return REDACTED;
  }

  get isSessionKey(): boolean {
    return this.#isSessionKey;
  }
}

export type SessionKey = SessionKeyHandle;

const SESSION_KEY_BYTES = new WeakMap<SessionKeyHandle, Uint8Array>();

export function importSessionKey(bytes: Uint8Array): SessionKey {
  if (!(bytes instanceof Uint8Array) || bytes.length !== SESSION_KEY_LENGTH) {
    throw new Error("importSessionKey: session key must be 32 bytes");
  }
  const handle = new SessionKeyHandle();
  SESSION_KEY_BYTES.set(handle, Uint8Array.from(bytes));
  return handle;
}

export function exportSessionKeyBytes(key: SessionKey): Uint8Array | null {
  const bytes = SESSION_KEY_BYTES.get(key);
  return bytes ? Uint8Array.from(bytes) : null;
}

export function destroySessionKey(key: SessionKey): void {
  const bytes = SESSION_KEY_BYTES.get(key);
  if (bytes) bytes.fill(0);
  SESSION_KEY_BYTES.delete(key);
}
