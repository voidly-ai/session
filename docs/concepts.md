# How a Session works

The default path is **discover → verify → hire → authorize → submit → redeem → recover**. A provider daemon decides what it accepts; that daemon and its operating policy are outside this package. The SDK provides the client flow and wire validators.

## Signed provider identity

`fetchVerifiedProvider` retrieves a provider manifest and verifies its signature against the DID the caller expected. Supply an explicit `expectedProviderDid`: the manifest's own assertion cannot be its only identity check. A public provider index is a discovery aid, not an endorsement or service guarantee.

```ts
const found = await fetchVerifiedProvider({
  manifestUrl,
  expectedProviderDid,
  fetchImpl: fetch,
});
// { ok: true, provider: VerifiedProvider }
// or { ok: false, reason: string, detail: string }
```

The `VerifiedProvider` carries signed service and price terms. `buildHire` checks the selected service and price against those terms. Use the signed manifest's chain, asset, payee, and amount band; the payer account is the caller's choice.

## Private hire and grant

`buildHire` seals the brief to the verified provider's encryption key. It returns a wire envelope for submission and a private `keep` for recovery. The brief and result are not public chain data. Retain the session key and grant hash securely; losing them can make recovery impossible.

The EIP-3009 authorization nonce is derived from the hash of the signed grant. The same nonce binds the payment to one hire. `receive_with_authorization` (default payee submission) and `transfer_with_authorization` (caller or facilitator submission) are alternative paths using that nonce, not two payment steps. The chain exposes payer, payee, amount, and time.

## Acceptance, settlement, and delivery

`submitHire` authenticates the provider's acceptance or refusal. `accepted` is an authenticated response to the hire; it is not itself a settlement or delivered result. On the default receive path, the payee submits the authorization. On the alternate transfer path, `payForGrant` can submit through an explicitly configured self or facilitator submitter, followed by a settlement hint when needed.

The provider checks settlement, performs work, and returns a sealed result with a signed delivery receipt. `recoverResult` returns tagged outcomes such as `opened`, `no_result`, `unopenable`, or an explicit refusal/error. A `no_result` response can be normal while work is underway. Retry recovery of the **same hire** after an uncertain network response; never create a new authorization simply because a response was lost.

## Assurance limits

- A verified signature identifies the key named by the DID; it does not prove provider quality or guarantee work.
- A successful payment buys an attempt on the published rail. A failed attempt can produce a sealed, signed failure result; there is no refund or reversal on this path.
- The relay can observe participant DIDs, envelope hashes, price band, settlement pointer, and timing, but not the sealed brief or result. Base transaction fields remain public.
- Optional customer-hosted jobs require owner review, bounded exact inputs, a current account session, a customer-controlled signer, and a persistent local spending journal. The current Voidpay flow requires the human owner's browser review and signature for each payment; do not give an agent the signer or payment submission path.
- SDK source and x402 facilitator helpers do not prove a current paid endpoint, a live facilitator, or a stock x402 client flow.
