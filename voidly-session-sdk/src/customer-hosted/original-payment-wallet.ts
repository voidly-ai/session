import {
  createPaymentContext, checkPaymentSignRequest, verifyPaymentSignature,
} from '../paymentContext';
import type { ReceiveAuthorizationTypedData } from '../payment';
import { hashText, parseContext, utf8ByteLength, type AuthContext } from './protocol';

export interface Eip1193Provider {
  request(args: Readonly<{ method: string; params?: readonly unknown[] }>): Promise<unknown>;
}
export type OriginalPaymentInput = Readonly<{
  context: AuthContext; originalId: string; grant: unknown; amount: string;
}>;
export type WalletSignRequest = Readonly<{
  method: 'eth_signTypedData_v4'; params: readonly [payer: string, typedDataJson: string];
}>;
export type OriginalPaymentAuthorization = Readonly<{
  context: AuthContext; originalId: string; grantHash: string; amount: string;
  payer: string; chainId: number; typedData: ReceiveAuthorizationTypedData;
  request: WalletSignRequest; typedDataFingerprint: string; requestFingerprint: string;
  /** Exact original wire spelling, including recovery byte 27/28. Never logged here. */
  signature: string;
}>;
export type WalletSignOutcome =
  | Readonly<{ status: 'signed'; authorization: OriginalPaymentAuthorization }>
  | Readonly<{ status: 'refused'; reason: string }>
  | Readonly<{ status: 'ambiguous'; reason: string; context: AuthContext; originalId: string; requestFingerprint: string }>;

type Snapshot = Readonly<{ context: AuthContext; originalId: string; grant: Readonly<Record<string, string>>; amount: string }>;
type Attempt = { input: string; promise: Promise<WalletSignOutcome> };
class Refusal extends Error { constructor(readonly reason: string) { super(reason); } }
const refused = (reason: string): WalletSignOutcome => Object.freeze({ status: 'refused', reason });

/** Match the native claim's canonical JSON after SDK admission. Sort object
 * keys only: EIP-712 member arrays are positional and must keep their order. */
export function canonicalOriginalPaymentTypedData(value: ReceiveAuthorizationTypedData): ReceiveAuthorizationTypedData {
  function ordered(v: unknown): unknown {
    if (Array.isArray(v)) return Object.freeze(v.map(ordered));
    if (v && typeof v === 'object') return Object.freeze(Object.fromEntries(
      Object.keys(v).sort().map(k => [k, ordered((v as Record<string, unknown>)[k])])));
    return v;
  }
  return ordered(value) as ReceiveAuthorizationTypedData;
}

function fields(value: unknown, expected?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Refusal('invalid_input');
  const keys = Reflect.ownKeys(value);
  if (keys.length > 32 || expected && keys.length !== expected.length) throw new Refusal('invalid_input');
  const out: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    if (typeof key !== 'string' || expected && !expected.includes(key)) throw new Refusal('invalid_input');
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !d.enumerable || !('value' in d)) throw new Refusal('invalid_input');
    out[key] = d.value;
  }
  return out;
}
function snapshot(value: unknown): Snapshot {
  const r = fields(value, ['context', 'originalId', 'grant', 'amount']);
  const context = parseContext(r.context);
  if (typeof r.originalId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(r.originalId)) throw new Refusal('invalid_original');
  if (typeof r.amount !== 'string' || !/^[1-9][0-9]{0,77}$/.test(r.amount)) throw new Refusal('exact_amount_required');
  const grant = fields(r.grant), sorted: Record<string, string> = Object.create(null);
  for (const name of Object.keys(grant).sort()) {
    if (typeof grant[name] !== 'string') throw new Refusal('invalid_grant');
    utf8ByteLength(grant[name], 4096); sorted[name] = grant[name];
  }
  return Object.freeze({ context, originalId: r.originalId, grant: Object.freeze(sorted), amount: r.amount });
}
function account(value: unknown): string {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) throw new Refusal('wallet_account_unavailable');
  const first = Object.getOwnPropertyDescriptor(value, '0');
  if (!first || !('value' in first) || typeof first.value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(first.value)) throw new Refusal('wallet_account_unavailable');
  return first.value.toLowerCase();
}
function chain(value: unknown): string {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value) || value.length > 66) throw new Refusal('wallet_chain_unavailable');
  return value.toLowerCase();
}
function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Refusal('wallet_timeout')), timeoutMs);
    // Both handlers remain attached after a timeout; a late signature/error cannot
    // escape or cause a second call. The ambiguous original stays locked.
    promise.then(value => { clearTimeout(timeout); resolve(value); }, error => { clearTimeout(timeout); reject(error); });
  });
}

/** Explicit caller action only. This is neither standing wallet permission nor
 * native original-job authority. A NEW adapter/reload cannot clear a native claim:
 * callers must reconcile that durable original before any subsequent invocation. */
export function createOriginalPaymentWalletAdapter(options: Readonly<{ provider: Eip1193Provider; timeoutMs?: number }>) {
  const provider = options.provider, timeoutMs = options.timeoutMs ?? 60_000;
  const capturedRequest = provider?.request;
  if (!provider || typeof capturedRequest !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000) throw new TypeError('Invalid wallet adapter options');
  const attempts = new Map<string, Attempt>();
  // Nonce ownership also prevents a different original ID/amount/context from
  // re-signing an authorization that may already have left this adapter.
  const authorizationOwners = new Map<string, string>();
  const sameProvider = () => { if (provider.request !== capturedRequest) throw new Refusal('wallet_provider_changed'); };
  const read = (method: 'eth_accounts' | 'eth_chainId') => Promise.resolve().then(() => {
    sameProvider();
    // Consume synchronous provider failures alongside the other parallel read.
    return capturedRequest.call(provider, Object.freeze({ method, params: Object.freeze([]) }));
  });
  async function walletMatches(payer: string, chainId: number) {
    const [currentAccount, currentChain] = await bounded(Promise.all([read('eth_accounts').then(account), read('eth_chainId').then(chain)]), timeoutMs);
    sameProvider();
    if (currentAccount !== payer) throw new Refusal('wallet_account_changed');
    if (currentChain !== `0x${chainId.toString(16)}`) throw new Refusal('wallet_chain_changed');
  }

  async function sign(selected: Snapshot, key: string): Promise<WalletSignOutcome> {
    let invoked = false, nonceKey: string | undefined, requestFingerprint = '';
    try {
      const created = await createPaymentContext({ grant: selected.grant, amount: selected.amount, entryPoint: 'receive_with_authorization' });
      if (!created.ok) throw new Refusal(created.reason);
      const context = created.context;
      const checked = checkPaymentSignRequest({ context, typedData: context.typedData });
      if (!checked.ok) throw new Refusal(checked.reason);
      if (checked.typedData.primaryType !== 'ReceiveWithAuthorization') throw new Refusal('receive_authorization_required');
      const typedData = canonicalOriginalPaymentTypedData(checked.typedData), payer = typedData.message.from, chainId = typedData.domain.chainId;
      const request: WalletSignRequest = Object.freeze({ method: 'eth_signTypedData_v4', params: Object.freeze([payer, JSON.stringify(typedData)] as const) });
      const typedDataFingerprint = await hashText(request.params[1]);
      requestFingerprint = await hashText(JSON.stringify({ version: 'voidpay.original-wallet-sign.v0', context: selected.context, originalId: selected.originalId, grantHash: context.grantHash, amount: selected.amount, request }));
      nonceKey = JSON.stringify([chainId, typedData.domain.verifyingContract, payer, typedData.message.nonce]);
      const owner = authorizationOwners.get(nonceKey);
      if (owner && owner !== key) throw new Refusal('authorization_original_conflict');
      authorizationOwners.set(nonceKey, key);
      await walletMatches(payer, chainId);
      const current = checkPaymentSignRequest({ context, typedData });
      if (!current.ok) throw new Refusal(current.reason);
      sameProvider();
      // Mark BEFORE calling the wallet: even a synchronous exception cannot prove
      // the request was never observed. No retry/broadcast is performed here.
      invoked = true;
      const signature = await bounded(Promise.resolve(capturedRequest.call(provider, request)), timeoutMs);
      await walletMatches(payer, chainId);
      const verified = verifyPaymentSignature({ context, signature });
      if (!verified.ok) throw new Refusal(verified.reason);
      return Object.freeze({ status: 'signed', authorization: Object.freeze({
        context: selected.context, originalId: selected.originalId, grantHash: context.grantHash,
        amount: selected.amount, payer, chainId, typedData, request, typedDataFingerprint,
        requestFingerprint, signature: verified.signature,
      }) });
    } catch (error) {
      const reason = error instanceof Refusal ? error.reason : invoked ? 'wallet_response_unconfirmed' : 'wallet_unavailable';
      if (invoked) return Object.freeze({ status: 'ambiguous', reason, context: selected.context, originalId: selected.originalId, requestFingerprint });
      // Nothing reached the signing method. An explicit caller retry can redo
      // preflight; it cannot change an already issued signing request.
      if (nonceKey && authorizationOwners.get(nonceKey) === key) authorizationOwners.delete(nonceKey);
      attempts.delete(key);
      return refused(reason);
    }
  }

  return Object.freeze({
    signOriginal(input: OriginalPaymentInput): Promise<WalletSignOutcome> {
      let selected: Snapshot;
      try { selected = snapshot(input); } catch { return Promise.resolve(refused('invalid_input')); }
      const key = JSON.stringify([selected.context.tenantId, selected.context.appId, selected.context.subjectId, selected.originalId]);
      const bytes = JSON.stringify(selected), prior = attempts.get(key);
      if (prior) return prior.input === bytes ? prior.promise : Promise.resolve(refused('original_conflict'));
      // Insert synchronously before the async work; concurrent invocations share
      // the exact same promise and cannot open two wallet approval prompts.
      const attempt = { input: bytes, promise: Promise.resolve().then(() => sign(selected, key)) };
      attempts.set(key, attempt);
      return attempt.promise;
    },
  });
}
