# Voidpay Sessions SDK documentation

These pages describe `@voidly/session` 1.4.3 and its public entry points. The package is an ESM client and shared wire protocol for a private, signed hire and its hire-bound USDC authorization on Base. Applications bring their own identity and payment signers. In the current Voidpay flow, a human owner reviews and signs each payment in the browser; the SDK does not grant unattended agent payment authority or run a provider service.

| Start here | Purpose |
| --- | --- |
| [Quickstart](quickstart.md) | Install, run an offline check, and integrate the default signed hire flow. |
| [Concepts](concepts.md) | Provider verification, sealed briefs, grant binding, payment and recovery boundaries. |
| [Main API reference](api-reference.md) | Root-entry functions with request and outcome examples. |
| [Subpath APIs](subpaths.md) | Break-even, Proofs, node-files, and customer-hosted entry points. |
| [Complete export index](export-index.md) | Every root-entry runtime value and TypeScript type, grouped by source module. |
| [Errors and refusals](errors.md) | How to handle `ok`, `kind`, transport errors, and payment uncertainty. |
| [FAQ](faq.md) | Runtime, x402, provider readiness, custody, Proofs, and owner-approved jobs. |

## Package entry points

| Import path | Use | Runtime |
| --- | --- | --- |
| `@voidly/session` | Hirer and provider flow, protocol, settlement, and transport helpers | ESM; Node 18+ or a compatible WebCrypto, `fetch`, `TextEncoder` runtime |
| `@voidly/session/break-even` | Relay-cost and offered-amount checks | ESM; package Node 18+ floor |
| `@voidly/session/proofs` | Credential-free public Proofs exercise helpers | ESM; package Node 18+ floor |
| `@voidly/session/proofs-auto` | Owner-preauthorized Proofs completion | ESM; package Node 18+ floor |
| `@voidly/session/node-files` | Bounded local file reads and verified create-once writes | Node only |
| `@voidly/session/customer-hosted` | Optional owner-approved automatic jobs and app programs | Node 24.15+ on Linux or macOS; persistent private directory |

The Proofs command-line tool (`voidly-session`, or `dist/proofsCli.mjs`) requires Node 20.3+. The optional customer-hosted entry has stricter requirements than the package root.

## Evidence boundary

The published [first-party settlement receipt](https://voidly.ai/pay-first-settlement.json) demonstrates the binding and settlement mechanism. It does not establish independent customer demand or that a selected provider currently accepts paid work. Check the [marketplace](https://voidly.ai/pay/marketplace) and the provider's signed terms before funding a job. Source-level x402 facilitator support does not establish a live x402 paid HTTP endpoint.
