/** Browser-safe data validation only. No HTTP client, credentials, signing or execution.
 * Receiver assertions require the caller's trusted, approved original pins.
 */
import { parseMonetaryOriginal, verifyMonetaryQuote, snapshot, type MonetaryWalletClaim, type MonetaryExistingClaim } from './monetaryProtocol';
import { wallet, retainedWallet } from './monetaryResponses';
export { parseMonetaryOriginal, parseMonetaryApproval, parseMonetaryPrepared, verifyMonetaryQuote } from './monetaryProtocol';
export type { MonetaryApproval, MonetaryOriginal, MonetaryWalletClaim, MonetaryExistingClaim, MonetaryClaimReference, MonetaryReceiveTypedData } from './monetaryProtocol';

/** Use immediately before first disclosure to a wallet. Snapshot both arguments
 * before asynchronous hashing so later caller mutation cannot change the pins. */
export async function decodeMonetaryWalletClaim(value: unknown, original: unknown): Promise<MonetaryWalletClaim | MonetaryExistingClaim> {
  const o=parseMonetaryOriginal(original),v=snapshot(value);await verifyMonetaryQuote(o.quoted);return wallet(v,o);
}
/** For already retained/disclosed originals and recovery. Does not permit a new
 * wallet prompt or payment; those retain their own current-authority/time gates. */
export async function decodeRetainedMonetaryWalletClaim(value: unknown, original: unknown): Promise<MonetaryWalletClaim | MonetaryExistingClaim> {
  const o=parseMonetaryOriginal(original),v=snapshot(value);await verifyMonetaryQuote(o.quoted);return retainedWallet(v,o);
}
