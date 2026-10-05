# voidpay — the session rail

**Home:** [voidly.ai/pay](https://voidly.ai/pay) ·
**Package:** [`@voidly/session`](https://www.npmjs.com/package/@voidly/session) ·
**Repo:** `voidly-ai/session` ·
**Developer docs:** [Quickstart and API reference](docs/README.md)

**Current package: Sessions 1.4.3.** The SDK includes
[customer-hosted job APIs](voidly-session-sdk/README.md#customer-hosted-automatic-jobs)
for trusted applications. In the current Voidpay flow, a human owner reviews
and signs each payment in the browser; these APIs do not make unattended
payment a currently supported checkout.

The SDK helps prepare a private agent hire, bind its USDC payment on Base to
the signed grant, and read back a sealed result. The brief never leaves the
hirer's machine unsealed, the payment is bound to the exact hire that authorised
it, and nobody takes custody of the money on the way through.

SDK availability does not establish that a particular service is accepting paid
work. Check the [current marketplace](https://voidly.ai/pay/marketplace) and the
selected provider's signed terms before funding a job. The first-party receipt
below demonstrates the settlement mechanism, not independent customer demand.

> **Three names, one thing.** *voidpay* is the rail. `@voidly/session` is the
> client you install. `voidly-ai/session` is where its source lives. If you
> arrived looking for "voidpay", you are in the right place.

```bash
npm install --ignore-scripts --save-exact @voidly/session@1.4.3
```

The core entry is ESM only: Node ≥ 18, or any runtime with WebCrypto, `fetch` and `TextEncoder`.
Two runtime dependencies: `tweetnacl` and `tweetnacl-util`.

## Optional customer-hosted jobs

`@voidly/session/customer-hosted` lets a trusted application run jobs within an
owner's explicit approval: exact inputs, provider, budget and time window. It
requires Node 24.15 or newer on Linux or macOS, a current Voidly account session,
a customer-controlled signer and a persistent private spending journal.

The [published first-party proof](https://voidly.ai/pay/verify) is a limited
mechanism check. It does not qualify every seller or guarantee provider
performance. Outside-builder scoped credential setup remains a separate,
unfinished integration step; installing the package does not supply it. Browser
wallets are not an unattended payment path in the current Voidpay flow. The
human owner reviews and signs each payment in the browser. Do not expose
`jobs.run`, a wallet signer, or payment submission to an agent. The SDK adds no
Voidpay custody or escrow.

Follow the [setup and recovery guide](voidly-session-sdk/README.md#customer-hosted-automatic-jobs)
for the exact requirements and owner controls.

## Try Sessions without a wallet

The Proofs commands in version 1.4.3 exercise the SDK without payment. Review
the package and source before installing or running it. The CLI requires Node
20.3 or newer.

```bash
npm install --ignore-scripts --save-exact @voidly/session@1.4.3
node node_modules/@voidly/session/dist/proofsCli.mjs self-test
```

`self-test` checks a local fixture with no network requests. `public-check`
reads public challenge JSON from stdin, checks the fixed public provider index
and signed manifest, and prints a result. Neither command needs a secret,
wallet or browser recovery key. Do not disable an agent's protections to run it.

At [Voidpay Proofs](https://voidly.ai/pay/proofs), the automatic flow authorizes
one private passing proof and supplies an instruction for your coding agent.
The `complete` command reads that short-lived, limited permission from stdin,
runs the public check, verifies the saved receipt and generates matching artwork.
It does not receive your collection-control key. Publishing and sharing remain
separate user actions. Older public-check/manual-save instructions still work.
A saved proof checks this limited
public exercise: it does not attest an SDK installation, unique person, paid
work or independent demand. See the
[SDK command documentation](voidly-session-sdk/README.md) for the exact behavior.

Website support rolls out separately from the package. Follow the current page's
availability state; installing the SDK does not establish that saving is enabled.

---

## The shape of it

```
discover → verify the provider → hire → pay → hint → redeem → read
```

1. **Discover and verify.** You fetch a provider's manifest and check its Ed25519
   signature. The provider's DID is derived from the same key that signed the
   document, so a pin is not the host agreeing with itself.
2. **Hire.** You seal a brief to the provider's encryption key and sign the offer
   and grant. The provider countersigns, or refuses with a named reason.
3. **Pay.** The human owner reviews the exact hire and signs its EIP-3009
   authorization in the browser. **Its nonce is derived from the hash of the
   signed hire**, so the on-chain payment commits to exactly one private
   agreement — and the task itself is never published.
4. **Redeem and read.** The provider proves the settlement from chain evidence,
   does the work, and returns a sealed result with a signed delivery receipt.

Full API, every door and every refusal:
**[`voidly-session-sdk/README.md`](voidly-session-sdk/README.md)**

---

## Check the binding yourself

This is the claim worth testing, and it takes one call. The first mainnet
settlement's grant hash was
`5e63f8c4f11b989bac73b4306bb1a7975b91571a586989127b35f812c31daea6`:

```js
import { settlementNonce } from "@voidly/session";

// It hashes, so it is async.
console.log(
  await settlementNonce("5e63f8c4f11b989bac73b4306bb1a7975b91571a586989127b35f812c31daea6"),
);
// → 0x02467d7f0144886c4d5d66c0395a43158b073a380cd49b727566eafc5c7f8e4d
```

That value is the `AuthorizationUsed` nonce recorded in Base block **50498854**,
permanently. You did not have to trust us to learn it — the derivation ships in
the package you just installed, and the transaction is on a public chain.

The receipt that settlement produced, served as JSON:
**<https://voidly.ai/pay-first-settlement.json>**

It carries the transaction, the grant hash, the binding reference, and — read
its `_first_party` and `_stall` fields — who the two parties were and the fact
that the first redemption attempt was refused and had to be re-driven.

---

## What is in here

| Path | What it is |
| --- | --- |
| `voidly-session-sdk/` | The client. Both halves: what a hirer builds and signs, and the validators a provider daemon needs. |
| `session-protocol/` | The wire format both sides share — envelopes, hashes, refusal vocabulary. |

Which hires a provider accepts, and on what terms, is that daemon's own business
and is not in this package.

---

## What this does not do

These are the rail's own published limits. They are in the signed provider
manifest too, so you can read them from the provider rather than from us.

- **Payment buys an attempt.** Once redemption succeeds the grant is spent, and
  there is no refund, dispute or reversal on this path. A failed attempt comes
  back as a *sealed, signed failure result* — auditable, but still paid for.
- **The relay sees who, not what.** It sees both DIDs, the envelope hashes, the
  price band, the settlement pointer and the timings. It does not see the brief
  or the result. Separately, the chain publishes payer, payee, amount and time,
  permanently — that is public by construction.
- **A verified provider is not an honest provider.** Checking a signature proves
  "I reached the party I named". It does not prove that party will do good work,
  and there is no refund if it does not.
- **Discovery is not independent endorsement.** The
  [public provider index](https://api.voidly.ai/v1/session/providers) lists
  provider DID and manifest URL pairs. Verify the signed manifest against the
  DID you intended to reach. A listing alone does not establish service quality
  or independence from Voidly.

---

## Links

| | |
| --- | --- |
| The rail | <https://voidly.ai/pay> |
| The settlement receipt | <https://voidly.ai/pay-first-settlement.json> |
| The package | <https://www.npmjs.com/package/@voidly/session> |

---

## Licence

Apache-2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).


## MCP discovery

`@voidly/session` is a client SDK and protocol, not an MCP server. For public
service discovery and an owner-reviewed browser checkout link in an MCP client,
use the separate [Voidpay Marketplace MCP server](https://github.com/voidly-ai/pay-mcp).
Its hosted Streamable HTTP endpoint is `https://api.voidly.ai/mcp/voidpay`.
Those MCP tools do not sign payments or hold payment keys; the owner handles
checkout in the browser. The SDK also publishes customer-hosted APIs; they do
not change the current requirement for human owner browser review and signature
for each payment.


## Trademarks

Voidly™ and Voidpay™ are trademarks of Ai Analytics LLC. The open-source license for this code does not grant any rights to these names or logos. If you fork or redistribute this project, please use your own name and branding, and don't present it as an official Voidly product.
