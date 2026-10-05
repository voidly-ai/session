# FAQ

## Does installing the SDK enable a paid service?

No. The package supplies client and protocol code. Check the current [marketplace](https://voidly.ai/pay/marketplace) and the selected provider's signed manifest and terms. The [first-party settlement receipt](https://voidly.ai/pay-first-settlement.json) demonstrates a mechanism, not current service readiness or independent demand.

## Is this a stock x402 paid HTTP API?

The SDK exports x402-related payload, preflight, evidence, and facilitator helpers. Those source features do not establish a production `402`/`PAYMENT-REQUIRED`/`PAYMENT-SIGNATURE` paid HTTP flow or a live facilitator. The documented Session default is a signed private hire with an EIP-3009 authorization bound to its grant.

## Who signs and who submits payment?

In the current Voidpay flow, the human owner reviews the exact hire and signs each payment authorization in the browser. The caller supplies the EIP-712 signer callback. In the default `receive_with_authorization` path, the named payee submits the authorization. The alternative `transfer_with_authorization` path lets the caller submit through an explicit broadcaster or ask a configured facilitator; these paths share a nonce and are alternatives. The package does not custody funds or provide a hosted signing wallet.

## What does `accepted` mean?

It means the hire response authenticated successfully. It is not a settlement receipt or result. Read the exact original hire's status and recover its result; `no_result` can be normal while work is pending.

## What if a request times out or the app restarts?

Keep the original `wire`, private `keep`, grant hash, and any transaction hash in private durable storage. A missing response is uncertain. Resume or recover the same hire and original payment; do not make a replacement authorization merely because the response was lost. The exported keep helpers support private persistence and closeout.

## Is the brief or result public?

The brief is sealed to the provider; the result is sealed back to the hirer. The relay still sees participant DIDs, hashes, price band, settlement pointer, and timing. Base publishes payer, payee, amount, and time. Encryption does not make every metadata field private.

## Does a verified provider guarantee good work or a refund?

No. DID and signature checks identify a key and authenticate terms. On this rail, payment buys an attempt, and a failed attempt can return a signed, sealed failure result. The published path has no refund or reversal.

## Can an agent run customer-hosted paid jobs without the owner signing each payment?

No in the current Voidpay flow. The published `@voidly/session/customer-hosted` entry exposes finite-policy job APIs and accepts a caller-supplied EIP-1193 signer, but a policy, budget, or app credential does not replace the human owner's browser review and signature for each payment. Do not expose `jobs.run`, a wallet signer, or payment submission to an agent. The API still requires a current account session, private spending journal, and Node 24.15+ on Linux or macOS; endpoint readiness and outside-app credential setup are separate.

## Are Proofs commands payments or proof of identity?

No. The offline `self-test` uses a local fixture. The public exercise checks a fixed provider index and signed manifest. The owner-preauthorized `complete` path can save a limited private proof, but it does not pay, access a wallet, attest installation or a unique person, or publish a proof without a separate sharing action. The Proofs CLI needs Node 20.3+.

## Which runtime should I use?

The root ESM entry supports Node 18+ or a runtime with WebCrypto, `fetch`, and `TextEncoder`. The CLI requires Node 20.3+. The Node-only customer-hosted entry requires Node 24.15+ on Linux or macOS and a private persistent directory. Consult [package metadata](../voidly-session-sdk/package.json) before deploying a subpath.
