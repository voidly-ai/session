import type { MonetaryOriginal, MonetaryWalletClaim, MonetaryExistingClaim } from './monetaryDecoders';
import type { OriginalPaymentTiming } from './originalPaymentTiming';
export type InvitedCheckoutSigningInput = Readonly<{
 original: MonetaryOriginal; claim: MonetaryWalletClaim | MonetaryExistingClaim;
 timing: Extract<OriginalPaymentTiming, { kind: 'ready' }>;
}>;
