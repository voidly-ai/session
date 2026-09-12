/** Browser scheduling only. These values never replace native authority or renew an original. */
export const ORIGINAL_PAYMENT_SUBMIT_BUDGET_MS = 55_000;
export const ORIGINAL_PAYMENT_MARGIN_MS = 2_000;
export const ORIGINAL_PAYMENT_MAX_WALLET_WAIT_MS = 120_000;
export const ORIGINAL_PAYMENT_MIN_WALLET_WAIT_MS = 30_000;

type WorkTiming = Readonly<{ nowMs: number; workNotAfterMs: number; requiredRemainingMs: number }>;
type PromptTiming = WorkTiming & Readonly<{ disclosureNotAfterMs: number }>;
export type OriginalPaymentTiming =
  | Readonly<{ kind: 'ready'; promptNotAfterMs: number; signatureNotAfterMs: number;
      submitNotAfterMs: number; walletTimeoutMs: number }>
  | Readonly<{ kind: 'unavailable'; reason: 'invalid_timing' | 'disclosure_expired' | 'insufficient_wallet_time' }>;

function capture(value: unknown, prompt: boolean): Record<string, number> | null {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  const keys = ['nowMs', 'workNotAfterMs', 'requiredRemainingMs', ...(prompt ? ['disclosureNotAfterMs'] : [])];
  if (Reflect.ownKeys(value).length !== keys.length) return null;
  const out: Record<string, number> = Object.create(null);
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !('value' in d) || !Number.isSafeInteger(d.value) || Object.is(d.value, -0) ||
        d.value < 0 || d.value > 8_640_000_000_000_000) return null;
    out[key] = d.value;
  }
  if (out.requiredRemainingMs < 54_000 || out.requiredRemainingMs > 600_000) return null;
  if (prompt && out.disclosureNotAfterMs > out.workNotAfterMs) return null;
  return out;
}

function deadlines(t: Record<string, number>) {
  // USDC authorization expiry is in whole seconds. Keep the provider's full
  // accepted work floor after dispatch; never extend the signed grant.
  const submitNotAfterMs = Math.floor(t.workNotAfterMs / 1000) * 1000 - t.requiredRemainingMs;
  const signatureNotAfterMs = submitNotAfterMs - ORIGINAL_PAYMENT_SUBMIT_BUDGET_MS - ORIGINAL_PAYMENT_MARGIN_MS;
  return { submitNotAfterMs, signatureNotAfterMs };
}

/** Call immediately before the one wallet prompt, using the verified original
 * and its approved requiredRemainingMs. Disclosure expiry bounds starting the
 * prompt; the unchanged work deadline bounds receiving and submitting its result.
 */
export function planOriginalPaymentTiming(value: PromptTiming): OriginalPaymentTiming {
  const t = capture(value, true);
  if (!t) return Object.freeze({ kind: 'unavailable', reason: 'invalid_timing' });
  if (t.nowMs >= t.disclosureNotAfterMs) return Object.freeze({ kind: 'unavailable', reason: 'disclosure_expired' });
  const d = deadlines(t), remaining = d.signatureNotAfterMs - t.nowMs;
  if (remaining < ORIGINAL_PAYMENT_MIN_WALLET_WAIT_MS) return Object.freeze({ kind: 'unavailable', reason: 'insufficient_wallet_time' });
  return Object.freeze({ kind: 'ready', promptNotAfterMs: t.disclosureNotAfterMs,
    ...d, walletTimeoutMs: Math.min(ORIGINAL_PAYMENT_MAX_WALLET_WAIT_MS, remaining) });
}

/** A returned signature belongs to the already-disclosed original. A fresh
 * server builder assertion is still required; an expired old quote is not renewed.
 * This is only a scheduling check, never authorization to sign or send again.
 */
export function canSubmitOriginalPayment(value: WorkTiming): boolean {
  const t = capture(value, false);
  return t !== null && t.nowMs < deadlines(t).signatureNotAfterMs;
}
