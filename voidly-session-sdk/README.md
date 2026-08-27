# @voidly/session

A client for the Voidly private-hire session rail: a hirer commissions sealed
work from a provider it has verified, pays for it on-chain with a pre-signed
EIP-3009 authorization bound to the hire, and reads back the sealed result.

Both halves are here. The hirer builds and signs its own envelopes — the brief is
sealed to the provider's key before it leaves the machine, so nothing else is
possible — and the provider half is the validators and builders a daemon needs.
Which hires a provider accepts, and on what terms, is a daemon's own business and
is not in this package.

---

## Install

```bash
npm install @voidly/session
```

That is the whole of it. The package is on the public registry under that exact
name, and nothing about getting the bytes needs an operator to hand you anything.

> **Building from a checkout instead?** Pack it yourself:
>
> ```bash
> npm run build && npm pack        # → voidly-session-1.0.1.tgz
> npm install /path/to/voidly-session-1.0.1.tgz
> ```
>
> Those are the same bytes `npm publish` uploads — `npm run gate` scans that
> tarball and nothing else — so a hire that works against a locally packed
> tarball works unchanged against the registry copy.

ESM only. Node ≥ 18 or any runtime with WebCrypto, `fetch` and `TextEncoder`.
Two runtime dependencies: `tweetnacl` and `tweetnacl-util`.

---

## Doors, not pieces

Six numbered steps carry a hire from a URL to an opened result. Each door
**composes** the steps under it in an order that matters, and each is shaped so
the mistake it guards against is not expressible.

**Step 3 is a fork, and step 5 is the same fork's other half.** Read the next
section before you write either.

| | | |
|---|---|---|
| 1 | `fetchVerifiedProvider` | a URL → a signed, **pinned** provider |
| 2 | `buildHire` | the offer, the grant, the sealed brief |
| 3 | **the payment fork** | `buildReceivePaymentAuthorization` *(default)* **or** `buildTransferPaymentAuthorization` |
| 4 | `submitHire` | build the envelope, send it, **authenticate** the answer |
| 5 | **who settles** | the provider relays — *nothing to call* **or** `payForGrant`, then `submitSettlementHint` |
| 6 | `recoverResult` | ask for the result, **authenticate** it, open it |

The pieces beneath them are exported too, because a caller with its own carrier
or its own wallet plumbing needs them. **The order is only guaranteed by the
doors.**

---

## The fork: who settles the payment

**Both authorizations carry the same nonce.** It is
`settlementBindingReference(grantHash)` — a function of the hire and of nothing
else — and USDC marks the `(authorizer, nonce)` pair spent forever on first use.
So the two are **alternatives, never steps**. Sign both and let both go out and
the second one spends real gas on a guaranteed revert, while the call that sent
it still hands you a transaction hash, because no submitter here waits for a
receipt.

| | **the provider relays** — default | **you settle** — opt-out |
|---|---|---|
| step 3 | `buildReceivePaymentAuthorization` | `buildTransferPaymentAuthorization` |
| step 5 | nothing to call | `payForGrant`, then `submitSettlementHint` |
| what you sign | `receiveWithAuthorization` | `transferWithAuthorization` |
| who can spend it | **only the payee named in it** | anyone holding the bytes |
| who pays the gas | the provider | you, or your facilitator |
| who writes the settlement pointer | the provider, from the chain | you, with the hint |

**The default is the provider relaying**, for one reason. The token restricts a
receive authorization to `msg.sender == to`, so it is not spendable by anyone but
the payee it already names. Every payment `payForGrant` produces is a bearer
payload: it is exposed to a front-run, and to a zero-cost decoy that is
unrecoverable once it lands. Take the opt-out when the provider does not relay —
and **ask the operator which it runs, because the signed manifest does not say.**
`PROVIDER_MANIFEST_KEYS` carries no relay field, exactly as it carries no hint
URL.

**On the default path, do not send a settlement hint.** The provider writes the
pointer itself, from the hash the chain agrees spent the nonce, and a hirer's
hint arriving after it is refused `409 hint_too_late` — permanently, and by
design: a pointer able to overwrite that one is how a settlement that landed gets
recorded as rejected. The retry advice under `submitSettlementHint` belongs to
the opt-out path only; here, retrying with a fresh clock never succeeds.

---

## A hire, end to end — the default

```ts
import {
  fetchVerifiedProvider,
  buildHire,
  buildReceivePaymentAuthorization,
  submitHire,
  recoverResult,
  x402SessionAccountCaip10,
} from "@voidly/session";

// 1. DISCOVERY. The only supported way to turn a URL into a provider. The
//    manifest is signed and the pin is REQUIRED: an attacker that keeps the
//    honest DID and swaps only the encryption key and the accept URL satisfies
//    DID derivation perfectly, and the brief is sealed to that key and posted to
//    that URL before any acceptance exists. Refusing to pay does not un-disclose
//    a brief.
const found = await fetchVerifiedProvider({
  manifestUrl,
  expectedProviderDid,   // the pin. REQUIRED — there is no unpinned arm.
  fetchImpl: fetch,
});
if (!found.ok) throw new Error(found.reason);

// 2. THE HIRE. `wire` is transmitted; `keep` is retained and never leaves the
//    machine — `keep.sessionKey` is the only secret in the protocol.
//
//    THE OFFERING IS LOOKED UP FIRST, AND EVERY MONEY FIELD BELOW IS COPIED OFF
//    IT. Four of the five are compared against this document with `===` and no
//    normalisation, so a value you type yourself is refused by name — see "the
//    price is not yours to type" below.
const SERVICE_REF = "voidly.observatory.query/v1";
const offering = found.provider.manifest.services.find((s) => s.ref === SERVICE_REF);
if (!offering) throw new Error(`this provider does not offer ${SERVICE_REF}`);

const hire = await buildHire({
  hirer: { did, signingPublicKeyBase64, sign },   // `sign` is Ed25519, detached
  provider: found.provider,
  // ONE OF THE REFS THE VERIFIED MANIFEST ALREADY OFFERS —
  // `found.provider.manifest.services[].ref`, compared with `===`. A ref this
  // provider does not offer is refused `provider_service_not_offered` here, by
  // name and before anything is signed.
  service: { ref: SERVICE_REF },
  task: { brief: "…" },
  price: {
    // FROM THE SIGNED DOCUMENT, not from your keyboard. `chain`, `asset` and
    // `payeeAccount` are compared `!==` against this offering and refused
    // `provider_price_chain_not_offered`, `provider_price_asset_not_offered`
    // and `provider_payee_not_manifested`.
    chain: offering.price.chain,
    asset: offering.price.asset,
    // THE ONE FIELD THAT IS GENUINELY YOURS. The payer account appears in no
    // manifest — it is the account the money LEAVES, and nothing the provider
    // publishes has anything to say about it. This is where the CAIP helper
    // belongs, and the only place it does.
    payerAccount: x402SessionAccountCaip10(offering.price.chain, payer)!,
    payeeAccount: offering.price.payee_account,
    // THE BAND MUST NEST INSIDE THE PUBLISHED BAND: `minAmount` may not fall
    // below `min_amount` (`provider_price_below_manifest_floor`) and
    // `maxAmount` may not rise above `max_amount`
    // (`provider_price_above_manifest_ceiling`). Copying both is the exact
    // price; pass them equal to any value inside the band to bid within it.
    minAmount: offering.price.min_amount,
    maxAmount: offering.price.max_amount,
  },
  // THE GRANT MAY NOT OUTLIVE THE OFFER. `grantMs > offerMs` is refused
  // `invalid_ttl` before anything is signed — an authorization can never outlive
  // the terms it points at — and the floor is 54s, twelve Base blocks plus the
  // clock skew the rail allows (`grant_ttl_below_settlement_depth`).
  //
  // AND IT MUST ALSO NEST INSIDE THE PROVIDER'S PUBLISHED WINDOW.
  // `found.provider.manifest.grant_ttl_ms` is `{min, max}`, covered by the same
  // signature as the price, and a `grantMs` outside it is refused
  // `provider_grant_ttl_below_manifest_floor` /
  // `provider_grant_ttl_above_manifest_ceiling`. The 600,000 below is a literal
  // because it has to be readable; check it against that band before you send.
  ttl: { offerMs: 30 * 60_000, grantMs: 10 * 60_000 },
  nowMs: Date.now(),
});
if (!hire.ok) throw new Error(hire.reason);

// 3. THE PAYMENT AUTHORIZATION — the RECEIVE variant, which only the payee can
//    spend. Every money-steering field is derived from the grant, none is an
//    argument. The binding nonce is a function of the grant hash, which is what
//    ties the money to this hire and nothing else.
//
//    THE OTHER VARIANT IS BELOW, AND IT IS NOT A LATER STEP. Same nonce, one
//    spend. Choosing this one means step 5 is the provider's, not yours.
const paid = await buildReceivePaymentAuthorization({
  grant: hire.wire.grant,
  grantHash: hire.keep.grant_hash,
  nowMs: Date.now(),
  sign: signReceive,     // your wallet's EIP-712 signer, over the RECEIVE struct
});
if (!paid.ok) throw new Error(paid.reason);

// 4. SUBMIT. Builds the envelope, sends it, and AUTHENTICATES the answer —
//    `accepted` is returned only when the countersignature verifies under the
//    provider key the hirer itself put in the grant, and only when the
//    acceptance names that same provider as redeemer.
const out = await submitHire({
  url: found.provider.manifest.accept_url,
  wire: hire.wire,
  grantHash: hire.keep.grant_hash,
  authorization: paid.authorization,
  sign,
  nowMs: Date.now(),
  fetchImpl: fetch,
});
switch (out.kind) {
  case "accepted": break;                       // proceed
  // Call `submitHire` again with the SAME `wire`, `authorization` and `sign`.
  // The envelope carries no nonce and no timestamp, so it rebuilds byte for
  // byte, and the provider is idempotent on `grant_hash`.
  case "undelivered": break;
  case "refused": /* see `steersPayment` below */ break;
  case "unverifiable": /* do NOT pay */ break;
  case "unbuildable": /* fix the arguments */ break;
}

// 5. NOTHING. The provider spends the authorization it now holds and writes its
//    own settlement pointer. You do not pay, and you do not hint.

// 6. READ WHAT YOU PAID FOR. One call: it mints the recovery request off the
//    grant, signs it, POSTs it, verifies the provider's delivery receipt under
//    the key the HIRER put in the grant, and opens the capsule against the
//    commitment on the receipt IT verified.
//
//    `baseUrl` COMES OFF THE SIGNED MANIFEST. `worker_base_url` is one of the
//    two doors the manifest publishes; a literal here would be a rail host
//    pasted into your code that no signature covers.
//
//    THERE IS NO `resultCommitment` PARAMETER, and that is the design. The only
//    commitment worth opening against is one that came off a verified receipt;
//    a door that took one could be handed the unverified copy that arrived on
//    the same wire as the bytes, which checks the answer against itself.
const read = await recoverResult({
  endpoint: { baseUrl: found.provider.manifest.worker_base_url },
  wire: hire.wire,
  grantHash: hire.keep.grant_hash,
  sessionKey: hire.keep.sessionKey,
  sign,
  nowMs: Date.now(),
});
if (read.kind === "opened") {
  console.log(read.result);              // the work
  console.log(read.receipt);             // the provider's signed statement about it
}
// `no_result` is the normal answer until the provider has delivered — poll it.
// read.kind: "opened" | "unopenable" | "unverifiable" | "no_result"
//          | "undelivered" | "unrecognized" | "unbuildable"
```

**If the delivery reaches you some other way** — pushed straight from the
provider, off a queue — use `openDeliveredResult` instead of `recoverResult`. It
is the same authentication and the same open, with no round trip, and it takes no
commitment either.

---

## The opt-out: you settle it yourself

This **replaces steps 3 and 5** above. Steps 1, 2, 4 and 6 are unchanged, so it
is written here as a function over what those steps already produced.

```ts
import {
  buildTransferPaymentAuthorization,
  payForGrant,
  submitHire,
  submitSettlementHint,
  x402SessionEvidence,
} from "@voidly/session";
import type {
  HireKeep,
  HireWire,
  SignTypedData,
  Signer,
  VerifiedProvider,
} from "@voidly/session";

export async function settleItYourself(input: {
  provider: VerifiedProvider;       // step 1
  wire: HireWire;                   // step 2
  keep: HireKeep;                   // step 2
  sign: Signer;                     // the Ed25519 identity signer from step 2
  signTransfer: SignTypedData;      // NOT the receive signer — a DIFFERENT struct
  facilitatorUrl: string;
  hintUrl: string;                  // from the operator; see the note below
}) {
  // 3′. THE TRANSFER VARIANT, instead of `buildReceivePaymentAuthorization`.
  const paid = await buildTransferPaymentAuthorization({
    grant: input.wire.grant,
    grantHash: input.keep.grant_hash,
    nowMs: Date.now(),
    sign: input.signTransfer,
  });
  if (!paid.ok) throw new Error(paid.reason);

  // 4. Unchanged.
  const out = await submitHire({
    url: input.provider.manifest.accept_url,
    wire: input.wire,
    grantHash: input.keep.grant_hash,
    authorization: paid.authorization,
    sign: input.sign,
    nowMs: Date.now(),
    fetchImpl: fetch,
  });
  if (out.kind !== "accepted") return out;

  // 5′. PAY. Preflight the facilitator, THEN sign, THEN submit — in that order,
  //     guaranteed by the door. Chain, payee, amount and window all come off the
  //     grant; none of them is an argument, which is also why this re-derives
  //     the IDENTICAL authorization signed above rather than a second one.
  //     `broadcast` instead of `facilitator` sends it from your own wallet.
  const settled = await payForGrant({
    grant: input.wire.grant,
    grantHash: input.keep.grant_hash,
    nowMs: Date.now(),
    signer: input.signTransfer,
    facilitator: { baseUrl: input.facilitatorUrl, fetchImpl: fetch },
  });
  if (!settled.ok) throw new Error(`${settled.reason}: ${settled.detail}`);

  // 5″. POINT THE PROVIDER AT THE PAYMENT. One call: it builds the hint, signs
  //     it, POSTs it, reads the answer. `provider_did` comes off the GRANT and
  //     the hash off the call that sent the money — neither is yours to choose.
  //     Its success arm is `acknowledged`, NOT `accepted`: nothing signs this
  //     door's answer, and the weaker word says so.
  //
  //     SEND IT AS SOON AS THE PAYMENT IS AWAY. On a provider that also relays,
  //     this pointer is what stops its relay arm; a daemon that gets there first
  //     cannot spend a transfer authorization and fails the hire instead.
  //
  //     RETRY BY CALLING IT AGAIN WITH A CURRENT CLOCK — never by re-sending kept
  //     bytes. The daemon admits only a strictly newer hint, so a replay reads,
  //     wrongly, as "my pointer never landed".
  return await submitSettlementHint({
    url: input.hintUrl,
    grant: input.wire.grant,
    grantHash: input.keep.grant_hash,
    evidence: x402SessionEvidence(settled.transactionHash),
    sign: input.sign,
    nowMs: Date.now(),
    fetchImpl: fetch,
  });
  // .kind: "acknowledged" | "refused" | "undelivered" | "unrecognized" | "unbuildable"
}
```

**The hint URL is a parameter, and the signed manifest does not publish one.**
`PROVIDER_MANIFEST_KEYS` carries `accept_url` and `worker_base_url` and nothing
else that is a door, so deriving a hint endpoint from `accept_url`'s origin would
be inventing a convention no signature covers. Pass the URL the operator gave
you.

---

## The price is not yours to type

**Four of the five money fields are copied off the signed manifest, and the
fifth is the only one you own.** `buildHire` compares `chain`, `asset` and
`payeeAccount` against the offering with `===` and no normalisation, and it
requires your `[minAmount, maxAmount]` to nest inside the published
`[min_amount, max_amount]`. Every mismatch is refused by name, before anything
is signed — `provider_price_chain_not_offered`,
`provider_price_asset_not_offered`, `provider_payee_not_manifested`,
`provider_price_below_manifest_floor`, `provider_price_above_manifest_ceiling`.
So the honest source for all four is `manifest.services[].price`, and the
example above reads them from there. `payerAccount` is the exception: it is the
account the money LEAVES, it appears in no manifest, and it is the one field
`x402SessionAccountCaip10` is for.

**A hard-coded `minAmount` is a hazard, and `"10000"` is a good illustration of
why.** Over 28 contiguous days of Base blocks (1,208,324 joint cost samples,
sampled 2026-08-23/24) one relayed `receiveWithAuthorization` cost a median of
about **1,519 micro-USDC** and a p99.9 of **11,456**. A published floor of
10,000 is 6.6× the median and **0.87× the p99.9** — solvent on an ordinary
afternoon and short of the gas on the days that decide whether a provider stays
up. It is not wrong by a lot; it is
wrong in the direction that only shows on the days that matter. A provider
whose floor does not clear its own relay cost watches USDC revenue climb until
the gas wallet empties and every accepted hire answers `relayer_cannot_pay_gas`
at once. Read the band off the manifest; do not carry a number from a document.

---

## Three more things that cost real money

**`validAfter` / `validBefore` are SECONDS.** Everything else in this protocol is
milliseconds. Milliseconds are refused by name rather than signed.

**The redemption proof header is single use.** Mint a fresh one per attempt; a
reused one is `409 provider_proof_replayed`.

**Simulate with `eth_call` before you spend** — on the opt-out path, where the
spending is yours. A reverted `transferWithAuthorization` emits no
`AuthorizationUsed`, so the settlement binding has nowhere to live and the
redemption can never resolve — while the relayer has already paid for the
failure. `createReadOnlyEvmRpc` and `simulateTransaction` do this without a key;
`createReadOnlyEvmRpc` refuses every write method before it touches the injected
`fetch`.

And one about refusals: a hire refusal carries no signature, so **any party in
the path can emit any refusal in the vocabulary.** `SubmitHireResult` sets
`steersPayment` on every refusal, and a `true` value means the only way to act on
it is to sign a NEW payment instrument. Never auto-remedy a `true`.

---

## A `VerifiedProvider` is a live value, not data

**It does not survive a round trip.** What makes a value a `VerifiedProvider` is
membership in a private table this package keeps, keyed by object identity — not
a field on the object. That is deliberate: a mark stored *on* the object can be
copied onto a different one by an ordinary `{ ...provider, manifest: other }`,
and a mark that survives a spread is not a mark. Membership cannot be copied.

The cost is a constraint worth knowing before you design around it:

* `structuredClone`, `JSON.parse(JSON.stringify(…))`, `postMessage` to a worker,
  and anything that persists the value and reads it back all produce an object
  that **still typechecks as `VerifiedProvider`** and is refused
  `provider_not_verified` by `buildHire`.
* Two copies of this package in one process keep two tables, so a provider
  verified through one is refused by the other.

**Keep the value in memory for the life of the hire, or keep the raw manifest
document and call `verifyProvider` on it again** — verifying a document you
already hold, with no fetch, is exactly what that export is for. Re-verifying is
cheap; it is signature checking over one small document.

---

## What `ok:true` does not mean

Every `validate*` on this surface answers about **structure** and about nothing
else. None of them checks a signature. Where this package publishes something
stronger about the same artifact, **only the stronger one ships** — which is why
you will find `verifyDeliveryReceipt` here and no `validateDeliveryReceipt`, and
`authenticateHireAcceptance` here and no `validateHireAccepted`.

One exception, named rather than hidden: `validateRedemptionAttestation`'s
artifact **is** signed, by the rail, and this package has no authenticated source
for the rail's signing key — so there is no stronger call it could offer instead.
`ok:true` from it is a statement about shape and carries no claim that the rail
issued the thing.

**Nine validators ship**, and the rule that decided each one is: if this surface
publishes a call taking THE SAME SINGLE ARTIFACT and answering a strictly
stronger question, only the stronger one ships. A tenth,
`validateDeliveryReceipt`, was removed under exactly that rule — `verifyDeliveryReceipt`
takes the same receipt and additionally checks the provider's signature. The
row-by-row working lives in the source header, which is not in this package:
`files` is `["dist", "README.md", "LICENSE", "NOTICE"]`, so what you have
installed is the bundle, the declarations, this document and the grant.

---

## The surface

| | |
|---|---|
| **Discovery** | `fetchVerifiedProvider` · `verifyProvider` · `isVerifiedProvider` · `PROVIDER_MANIFEST_KEYS` |
| **Hirer** | `buildHire` · `submitHire` · `authenticateHireAcceptance` · `buildHireMessage` · `signHireAuthorization` · `verifyDeliveryReceipt` · `hashArtifact` |
| **Recovery** | `recoverResult` (the door) · `openDeliveredResult` · `buildRecoveryRequest` · `postRecover` · `validateRecoveryRequest` |
| **Payment** | `buildReceivePaymentAuthorization` · `buildTransferPaymentAuthorization` · `settlementNonce` · `buildReceiveAuthorizationTypedData` · `EVM_USDC_EIP712_DOMAINS` · `x402SessionEvidence` |
| **Submission** | `payForGrant` (the door) · `signReceiveAuthorization` · `createFacilitatorSubmitter` · `createSelfSubmitter` · `preflightFacilitator` · the calldata and x402 payload builders |
| **Relay** | `createReadOnlyEvmRpc` · `createPayeeRelayBroadcaster` · `simulateTransaction` · `estimateRelayCost` · `resolveSettlementTransaction` · `checkSingleAuthorizationRelay` |
| **Settlement** | `submitSettlementHint` (the door) · `buildSettlementHint` · `settlementBindingReference` · `SETTLEMENT_BINDING_DOMAIN` |
| **Provider** | `reviewHire` · `acceptHire` · `openBrief` · `sealTaskResult` · `signDelivery` · `buildRedemptionProofHeader` |
| **Primitives** | `canonicalBytes` · `envelopeHash` · `signCanonical` · `verifyDetached` · `timestampMs` · `deriveDidFromSigningKey` · the CAIP predicates and the schema bounds |

Every validator returns `Validated<T, Reason>` — `{ ok: true, env }` or
`{ ok: false, reason }`. Nothing throws for a protocol refusal.

---

## Identity

`did:voidly:<base58>` derived from an Ed25519 signing key. Signatures are
detached Ed25519 over a canonical JSON encoding (`canonicalBytes`), which both
sides compute with the code in this package — that is the point of publishing it.
Bring your own key: nothing here mints, stores or transmits a private key, and
every signer is an injected `(bytes: Uint8Array) => Uint8Array`.

---

## Licence

Apache-2.0. `LICENSE` carries the full text and `NOTICE` carries the
attribution required by section 4(d); both ship inside the tarball, so the
grant travels with the bytes rather than living only in the manifest.

The grant covers a patent licence and terminates for anyone who brings a
patent action over this work. Trademarks are not granted — section 6.

The two runtime dependencies, `tweetnacl` and `tweetnacl-util`, are public
domain (Unlicense) and are marked external at build time, so the published
bundle contains no third-party code.
