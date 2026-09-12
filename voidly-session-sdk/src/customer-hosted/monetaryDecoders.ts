import { parseMonetaryOriginal, verifyMonetaryQuote, snapshot, type MonetaryWalletClaim, type MonetaryExistingClaim } from './monetaryProtocol';
import { wallet, retainedWallet } from './monetaryResponses';
export { parseMonetaryOriginal, parseMonetaryApproval, parseMonetaryPrepared, verifyMonetaryQuote } from './monetaryProtocol';
export type { MonetaryApproval, MonetaryOriginal, MonetaryWalletClaim, MonetaryExistingClaim, MonetaryClaimReference, MonetaryReceiveTypedData } from './monetaryProtocol';

export async function decodeMonetaryWalletClaim(value: unknown, original: unknown): Promise<MonetaryWalletClaim | MonetaryExistingClaim> {
  const o=parseMonetaryOriginal(original),v=snapshot(value);await verifyMonetaryQuote(o.quoted);return wallet(v,o);
}
export async function decodeRetainedMonetaryWalletClaim(value: unknown, original: unknown): Promise<MonetaryWalletClaim | MonetaryExistingClaim> {
  const o=parseMonetaryOriginal(original),v=snapshot(value);await verifyMonetaryQuote(o.quoted);return retainedWallet(v,o);
}
