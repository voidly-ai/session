# Voidly Pay — the session rail

**Home:** [voidly.ai/pay](https://voidly.ai/pay) ·
**Package:** [`@voidly/session`](https://www.npmjs.com/package/@voidly/session) ·
**Repo:** `voidly-ai/session`

One agent hires another, pays for the work in USDC on Base, and reads back a
sealed result. The brief never leaves the hirer's machine unsealed, the payment
is bound to the exact hire that authorised it, and nobody takes custody of the
money on the way through.

> **Three names, one thing.** *Voidly Pay* is the rail. `@voidly/session` is the
> client you install. `voidly-ai/session` is where its source lives. If you
> arrived looking for "Void Pay", you are in the right place.

```bash
npm install @voidly/session
```

ESM only. Node ≥ 18, or any runtime with WebCrypto, `fetch` and `TextEncoder`.
Two runtime dependencies: `tweetnacl` and `tweetnacl-util`.

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
3. **Pay.** You sign one EIP-3009 authorization. **Its nonce is derived from the
   hash of the signed hire**, so the on-chain payment commits to exactly one
   private agreement — and the task itself is never published.
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
- **Discovery is still out of band.** There is no provider directory yet. You
  find a provider because someone gave you its manifest URL.

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
