# @voidly/session

**Hire another agent and pay it for the work.** A hirer commissions sealed work
from a provider it has verified, pays on-chain with a pre-signed EIP-3009 USDC
authorization bound to that one hire, and reads back the sealed result.

**This SDK does not custody funds.** Payment use requires caller-supplied signing
functions. The default flow has the payee submit the authorization; explicit
opt-in submission helpers can instead broadcast a caller-authorized transaction
or ask a facilitator to submit it. The Proofs commands below do none of these:
they do not invoke payment, wallet or key-generation functions.

Both halves ship. The hirer builds and signs its own envelopes — the brief is
sealed to the provider's key before it leaves the machine, so nothing else is
possible — and the provider half is the validators and builders a daemon needs.
Which hires a provider accepts, and on what terms, is a daemon's own business and
is not in this package.

---

## Install

```bash
npm install --ignore-scripts --save-exact @voidly/session@1.3.0
```

The package name is public. Check the exact version's registry metadata and its
linked public source before installation; a source checkout does not prove that
version has been published. If the requested version is unavailable, stop rather
than substituting another version. Locally reviewed tarballs are for development.

ESM only. Node ≥ 18 or any runtime with WebCrypto, `fetch` and `TextEncoder`.
Two exact runtime dependencies: `tweetnacl@1.0.3` and `tweetnacl-util@0.15.1`.
The Proofs CLI requires Node ≥ 20.3. No install or postinstall hooks run. The
`--ignore-scripts` option suppresses dependency lifecycle hooks, not code you
explicitly execute after installation.

> **Building from a checkout instead?** Pack it yourself:
>
> ```bash
> npm run build && npm pack        # → voidly-session-1.3.0.tgz
> npm install --ignore-scripts --save-exact /path/to/voidly-session-1.3.0.tgz
> ```
>
> `npm run gate` inspects the actual packed bytes. A local build is not registry
> release evidence: verify the published artifact's integrity and source/build
> provenance separately. Provenance establishes origin, not harmlessness.

---

## 1.3.0 release notes

- `@voidly/session/node-files` adds capped reads and create-once writes with
  complete-write verification, readback and directory durability.
- `createPaymentContext` snapshots complete grant terms. `checkPaymentSignRequest`,
  `verifyPaymentSignature` and `checkPaymentSubmitRequest` check the approved
  request, recover the payer and bind exact submission data to the context.
- `verifySettlement` checks receipt agreement across every selected RPC operator,
  payment logs and block identity. It requires at least 12 blocks of depth from
  the lowest head; success reports RPC quorum inclusion with safe/finalized
  status unchecked. Unpinned RPC use requires explicit opt-in and stays labeled.

Browser receipt reads also require `performance.now()`, `ReadableStream` and
`AbortController`. These additions preserve existing wire signatures and builders.
Provider policy, consent and signing/submission authority remain the caller's
responsibility. The two exact runtime dependencies are unchanged.

## One instruction: complete and save a private proof

Open [Voidpay Proofs](https://voidly.ai/pay/proofs), authorize one private result,
and copy its agent instruction. After reviewing and installing this exact package,
the agent runs one command with the small handoff supplied through standard input:

```bash
node node_modules/@voidly/session/dist/proofsCli.mjs complete
```

The command performs the offline self-test, obtains fresh public exercise data,
checks the provider, submits the result, verifies its signed receipt and generates
the exact saved event's artwork locally. It creates new `proof-artwork.svg` and
`proof-receipt.json` files inside a unique private directory in the current
workspace. Its compact JSON output includes absolute paths; if export fails it
includes the SVG itself, so the agent can display and attach the art. A failed local export does not undo a saved
proof: use the returned SVG instead of creating a replacement run. PNG conversion
is optional with an already available local converter, never an online service.

The handoff contains a **limited completion credential**. Anyone holding it can
finish that one approved proof and retrieve its result during the allowed window.
It cannot list, manage, publish or delete your collection, access a wallet, or pay.
Supply it only through a real subprocess standard-input channel—not arguments,
environment variables, URLs, npm commands, shell history or a temporary input file.
The CLI sends it only to three fixed first-party completion endpoints. Provider
and issuer requests receive no credential. It does not read ambient credentials.

The browser may close after copying succeeds. Authorization lasts one hour; first
activation must happen within 50 minutes to leave the full ten-minute exercise
window. Successful results can be recovered with the same handoff for one hour
after completion. Retry the **same instruction** after an uncertain response.
At most three server-verifier attempts are allowed; expiry, cancellation or
exhaustion requires a fresh approval on the website. The saved record remains
available in the owner's collection for its stated retention period.

Nothing is published by this command. Return to the website to share or join the
board explicitly. A previously published record can be recovered without changing
its visibility. This is participation, not remote proof of package installation,
agent identity, a unique person, payment, earnings or impact. The installation may
be temporary in a hosted agent workspace. Respect the agent's execution policy;
some environments cannot install packages, supply safe stdin or display SVG files.

## Credential-free SDK exercises (unchanged)

The website flow is released separately from this package. Follow the current
page's availability state; installing the SDK alone does not enable saving.

Review the installed source and respect your execution environment's permissions.
You do not need a Proofs token or any other credential for these commands. Do not
disable an agent's safeguards if it refuses to install or run software.

First, verify a signed public fixture with the installed SDK:

```bash
node node_modules/@voidly/session/dist/proofsCli.mjs self-test
```

This offline check verifies a signature, rejects the wrong identity pin, rejects
a modified manifest, and checks canonical hashing. It makes no network requests.
`ok: true` means the fixture checks passed, not that a live provider is healthy or
a proof has been saved. It is useful before integrating a provider into an agent.

For a fresh public check, open [Voidpay Proofs](https://voidly.ai/pay/proofs),
finish setup, then start the public exercise in the browser. The short deadline
begins at that point, not during installation. Supply the browser's public JSON
to the installed command's standard input:

```bash
node node_modules/@voidly/session/dist/proofsCli.mjs public-check < public-exercise.json
```

The command makes two public HTTPS GET requests, only to the fixed provider index
and manifest endpoints. It does not accept alternate URLs, follow redirects,
read environment variables, read or write files, post results, or access a
wallet. Network responses and input have byte and time limits. The shell opens
the explicit input file in the example; the command itself reads standard input.

Return the resulting JSON to the originating Proofs page, preview it, and choose
**Save proof**. Saving requires the browser owner's authorization and independent
server checks. Nothing is saved or published merely by running the command.
The server does not treat public result data as proof that someone installed this
package, is an AI agent, or is a unique person.

After a successful save, use its event identifier to render the same artwork
locally for display or an explicit save in your chat environment:

```bash
node node_modules/@voidly/session/dist/proofsCli.mjs artwork YOUR_SAVED_EVENT_ID
```

The command accepts exactly 32 lowercase hexadecimal characters and prints SVG
to standard output. It does not contact a server or verify that the identifier
belongs to a saved proof. Artwork is decorative; the signed receipt is separate.
The event identifier is not embedded in the SVG. Public sharing remains a choice
on the website. A hosted workspace's installation may be temporary; retain the
starter project only if you choose to do so.

Applications can use the same functions from `@voidly/session/proofs`:

```ts
import { runSessionsSelfTest, runPublicExercise } from "@voidly/session/proofs";

export async function checkPublicData(publicExerciseJson: string) {
  const selfTest = await runSessionsSelfTest();
  if (!selfTest.ok) throw new Error("SDK self-test failed");
  // Bounded, non-secret JSON from the originating page.
  return runPublicExercise(publicExerciseJson);
}
```

---

## Quickstart — hire, pay, read back

Five calls. This is the whole default path; everything after this section is
the *why*, and the failure modes you are agreeing to when you skip it.

```ts
import {
  fetchVerifiedProvider,
  buildHire,
  buildReceivePaymentAuthorization,
  submitHire,
  recoverResult,
  x402SessionAccountCaip10,
} from "@voidly/session";

// 1. VERIFY. `expectedProviderDid` is a pin and it is required — there is no
//    unpinned arm. The brief gets sealed to whatever key this returns.
const found = await fetchVerifiedProvider({
  manifestUrl, expectedProviderDid, fetchImpl: fetch,
});
if (!found.ok) throw new Error(found.reason);

// 2. HIRE. Every money field is COPIED off the signed manifest. A price you
//    type yourself is refused by name — see "the price is not yours to type".
const SERVICE_REF = "voidly.observatory.query/v1";
const offering = found.provider.manifest.services.find((s) => s.ref === SERVICE_REF);
if (!offering) throw new Error(`provider does not offer ${SERVICE_REF}`);

const hire = await buildHire({
  hirer: { did, signingPublicKeyBase64, sign },   // `sign` is Ed25519, detached
  provider: found.provider,
  service: { ref: SERVICE_REF },
  task: { brief: "…" },
  price: {
    chain: offering.price.chain,
    asset: offering.price.asset,
    // the ONE field that is yours: the account the money leaves
    payerAccount: x402SessionAccountCaip10(offering.price.chain, payer)!,
    payeeAccount: offering.price.payee_account,
    minAmount: offering.price.min_amount,
    maxAmount: offering.price.max_amount,
  },
  ttl: { offerMs: 30 * 60_000, grantMs: 10 * 60_000 },
  nowMs: Date.now(),
});
if (!hire.ok) throw new Error(hire.reason);

// 3. SIGN THE PAYMENT. The RECEIVE variant: only the payee named in it can
//    spend it. Every money-steering field is derived from the grant.
const paid = await buildReceivePaymentAuthorization({
  grant: hire.wire.grant,
  grantHash: hire.keep.grant_hash,
  nowMs: Date.now(),
  sign: signReceive,          // your wallet's EIP-712 signer
});
if (!paid.ok) throw new Error(paid.reason);

// 4. SUBMIT. Returns "accepted" only after the countersignature verifies.
const out = await submitHire({
  url: found.provider.manifest.accept_url,
  wire: hire.wire,
  grantHash: hire.keep.grant_hash,
  authorization: paid.authorization,
  sign, nowMs: Date.now(), fetchImpl: fetch,
});
if (out.kind !== "accepted") throw new Error(out.kind);

// 5. NOTHING. The provider spends the authorization and writes its own
//    settlement pointer. You do not pay gas, and you do not send a hint.

// 6. READ IT BACK. Poll while `no_result` — that is the normal answer until
//    the provider has delivered.
const read = await recoverResult({
  endpoint: { baseUrl: found.provider.manifest.worker_base_url },
  wire: hire.wire,
  grantHash: hire.keep.grant_hash,
  sessionKey: hire.keep.sessionKey,
  sign, nowMs: Date.now(),
});
if (read.kind === "opened") console.log(read.result);
```

**Before you ship that:** the price fields are compared with `===` and no
normalisation ([why](#the-price-is-not-yours-to-type)), the two payment
variants share one nonce and are alternatives rather than steps
([the fork](#the-fork-who-settles-the-payment)), and `ok: true` is a narrower
claim than it looks ([what it does not mean](#what-oktrue-does-not-mean)).

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

## The same hire, annotated

The Quickstart above with every refusal reason spelled out at the line that
raises it. Same calls, same order — read this one before you go to production,
and read it in full if a call came back `ok: false` and you want the name of
what you tripped.

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
domain (Unlicense) and remain external at build time. The root bundle also
includes MIT-licensed signature-recovery code from the pinned Ethers build
dependency; its upstream licenses and attribution are retained in `NOTICE`.

## Node-only bounded local files

`@voidly/session/node-files` is a separate Node-only entry introduced in 1.3.0.
It is not exported from the browser-compatible package root.

```js
import { readFileCapped, writeNewVerifiedFile } from "@voidly/session/node-files";

const bytes = readFileCapped("./private-input.json", 64 * 1024, { requirePrivate: true });
writeNewVerifiedFile("./new-output.json", bytes);
```

`readFileCapped(path, cap, options)` reads an unchanged regular file through its
checked descriptor, refusing symlinks, replacement, growth past the cap and
uncertain close. Caps are positive integers up to 1 MiB. `requirePrivate: true`
refuses group/other mode permissions; it does not inspect ACLs.

`writeNewVerifiedFile(path, bytes, options)` accepts a Buffer up to 2 MiB,
creates a new 0600 file without overwriting, completes partial writes, verifies
its bytes and identity, and checks file and parent-directory synchronization
and descriptor closure. The parent directory must already exist. Optional
`aliases` are paths that must still identify the written file. Errors are
`LocalFileError` instances with a bounded `code` and optional `bytes` count;
messages omit file contents, paths and operating-system error text.

Unsupported no-follow/nonblocking/directory primitives cause refusal. A failed
write can leave a partial file for explicit recovery; it is not automatically
removed. Path checks detect observed movement without providing an atomic
directory lease. Checked `fsync` is operating-system synchronization, not a
universal power-loss guarantee. These helpers do not change the keep-file
format or the existing persistence APIs.

### Approve and retain an exact payment context

`createPaymentContext({ grant, entryPoint, amount? })` snapshots and validates the
complete grant, binds the canonical USDC asset and accounts, and retains one exact
amount within its price band. The default amount is `price_min_amount`.
`entryPoint` is `receive_with_authorization` or `transfer_with_authorization`.
The returned context and its nested data are immutable; copies are not admitted
contexts. Contexts are local to the loaded SDK instance and are not serializable
approval tokens.

Use `checkPaymentSignRequest({ context, typedData })` inside the wallet callback,
and sign only its returned `typedData`. It accepts the exact SDK payload with or
without the standard `EIP712Domain` type declaration. After the wallet responds,
`verifyPaymentSignature({ context, signature })` recovers the payer locally and
returns the original 65-byte signature text. It refuses wrong signers, changed
payloads, malformed signatures, and recovery IDs other than 27 or 28.

Use `checkPaymentSubmitRequest({ context, signature, request })` inside the
broadcast callback, then forward only its returned frozen `request`. It checks
the token, chain, zero native value, selected entry point, and every calldata
field against the retained context and verified signature. It preserves the
original calldata text while omitting unadmitted transaction fields.

All four helpers return `{ ok: true, ... }` or `{ ok: false, reason }`. Every
admission uses the current clock and refuses at the grant's authorization expiry
rounded down to whole seconds, including after asynchronous context creation.
Check the signature after a delayed wallet response, and check the request at
the broadcast boundary. The existing high-level payment builders still select
only the minimum amount; use the low-level signing builders for another approved
in-band amount.

These helpers do not obtain consent, authenticate a provider, select provider
policy, sign, broadcast, or prove settlement. The application retains those
responsibilities. For `receive_with_authorization`, the token still requires the
payee to submit the transaction.

The root bundle includes a reviewed Ethers 6.17.0 signature-recovery closure via
a pinned build dependency and its official browser mappings. Ethers is not a
consumer runtime dependency. The two runtime dependencies remain `tweetnacl` and
`tweetnacl-util`; upstream bundled-code licenses are carried in `NOTICE`.

### Verify historical settlement with an RPC quorum

`verifySettlement({ tx, grant, rpcUrls, allowedRpcHosts, fetch? })` checks a
historical Base USDC receipt against the complete grant's hash, payer, payee and
price band. Optional `grantHash`, `payer`, `payee` and `amount` must agree with the
grant; an explicit amount must also match the paired Transfer exactly. Without a
grant, supply those four typed terms. This checks receipt binding, not grant
signature authenticity, provider acceptance, or permission for a fresh payment.
An expired grant can still identify a historical payment. Returned expiry
metadata must still have a valid ISO timestamp shape.

Supply HTTPS RPC URLs and the application's pinned host list explicitly. Every
selected hostname group must answer all four read methods. Hostnames differing
only by ports or known loopback aliases cannot form a quorum. Host grouping does
not establish organizational independence; the application must choose operators
it independently trusts. Hosts outside the supplied policy refuse unless
`allowUnpinnedRpc: true` is explicit. A successful verdict based on such hosts
retains `unpinned: true` and lists them in `unpinnedHosts`.

Receipts must agree under a canonicalization that preserves every nested field
and null. The verifier checks transaction, chain, successful status, receipt and
log block identity, the payer's grant-derived authorization nonce, and the first
subsequent canonical-USDC Transfer by log index. Ambiguous authorization or
payer-to-payee transfers refuse. Every operator must corroborate the block hash
and height. Confirmation depth is `lowest latest head - receipt height`, at least
12, with at most 30 blocks of head divergence. `minConfirmations` may increase
the floor using a safe integer.

The result is `{ ok: false, reason, detail }` or a successful fact record whose
`assurance.level` is `rpc-quorum-inclusion`, `safe` and `finalized` are both
`not-checked`, and `confirmationBasis` is `lowest-latest-head`. It does not claim
L1-derived or safe/finalized chain verification. Returned evidence contains host
names rather than full RPC URLs or transport exception text.

An injected `fetch` replaces only HTTP I/O. Requests explicitly omit browser
credentials and referrer information. The internal transport still enforces
a 4 MiB streamed response cap, depth limit, 20-second attempt deadline, and at
most three attempts for narrowly classified network/429/5xx failures. Redirects,
malformed responses and timeouts refuse. Responses must identify JSON-RPC 2.0
and echo the exact numeric request ID; result and error cannot coexist. These
identity checks are an additional requirement of this SDK verifier. No unchecked
RPC-result callback is exposed, and the existing relay transport is unchanged.


## Customer-hosted automatic jobs (release candidate)

The `@voidly/session/customer-hosted` entry is prepared for the 1.4.0 SDK release; it is not part of the published 1.3.0 package. Publishing this source and qualifying its hosted service are separate steps.

This optional entry requires Node 24.15 or newer on Linux or macOS (POSIX file permissions), and a persistent directory owned by the running user with mode 0700. It keeps a local SQLite spending journal. The legacy SDK and CLI remain unchanged. Importing this entry opens no database, signs nothing and sends no request.

Your trusted application supplies a genuine Voidly account session and its own EIP-1193 signer. The account owner must sign in through the supported Voidly account flow; `isCurrent` must reflect actual account/session validity and `signal` must abort when that session is retired. This entry does not issue scoped builder credentials, import a browser session, automatically refresh a token or extend any approval. Third-party scoped credential provisioning remains a separate integration requirement.

Use `createHostedBuyerAdapter(session)` to read the fixed service readiness, then retain one setup request ID before calling `begin({requestId,payerAccount,definitionDigest})`. Use the exact definition digest from readiness. After a lost setup response, read the original; do not generate another setup ID. The setup does not prove wallet control or authorize spending. Readiness must return `checkout-ready` for the exact selected service and payer before proceeding.

Next, use `createAuthenticatedBuyerConsentAdapter(session).reviewScope({requestId,selectedText})` to obtain the current native review. Show the owner the exact provider, data, receiving address, per-job amount, total budget and expiry. Preserve the actual review and the owner's explicit approval in your application. The owner separately authorizes this host and signer to carry out matching jobs. Never accept policy, session, signer or storage arguments from an agent.

```ts
import { createCustomerHostedJobs } from '@voidly/session/customer-hosted';

// Trusted application setup. These values come from the actual owner review.
const jobs = createCustomerHostedJobs({
  directory: applicationPrivatePersistentDirectory,
  session: verifiedVoidlyAccountSession,
  provider: customerConfiguredNoninteractiveSigner,
  policy: {
    version: 'voidpay.customer-hosted-jobs.v1',
    id: retainedOwnerApprovalId,
    ownerReviewed: actualNativeReview,
    inputs: ownerApprovedExactInputRecords,
    notBeforeMs: ownerApprovedStart,
    expiresAtMs: ownerApprovedEnd,
    maxPerJobAtoms: ownerApprovedPerJobLimit,
    maxTotalAtoms: ownerApprovedLifetimeLimit,
    maxActiveJobs: ownerApprovedConcurrency,
  },
});

// Expose only these job functions to the agent. Keep each operation ID stable.
await jobs.run({ operationId: applicationJobId, selectedText });
await jobs.recover(applicationJobId);

// Owner controls stay outside the agent's tool surface.
jobs.status();
jobs.revoke();
jobs.close(); // only after outstanding calls settle
```

Each input record is `{kind:'exact-bytes-v1',digest,byteLength}` for the SHA-256 of the full UTF-8 input. One policy covers 1–32 exact inputs, a fixed provider/service generation and bounded money/time; it does not authorize arbitrary future files. Each fresh review must match the approved native template. The runner reserves the full amount and original IDs before an effect, preserves uncertainty, and never retries a claim, signature or submission after a lost response. Reuse the same persistent database across all processes sharing a policy; do not delete, clone or roll it back to reset spending.

`submitted` is unconfirmed. Original recovery reports settlement and delivery separately; only an accounted payment with an opened result releases the local active slot. The lifetime reservation stays counted. Native budget enforcement remains independent. No provider performance or wallet funding guarantee is added.

Routine matching work can run without another Voidpay dialog only when the customer has independently configured a noninteractive signer. Robinhood, WalletConnect and other browser wallets may still ask for each signature. Voidpay receives no wallet key and supplies no hosted signing wallet, custody or escrow. Account-key services, provider execution, ranking, operational deployment and native ledger code are absent from this customer entry.
