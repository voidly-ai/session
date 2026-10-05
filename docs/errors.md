# Errors, refusals, and uncertain effects

Most Session validators and builders return a discriminated result. Inspect its tag before reading success fields. Do not turn a lost HTTP response into a fresh hire or payment authorization.

## `ok` results

Builders and validators such as `fetchVerifiedProvider`, `buildHire`, `buildReceivePaymentAuthorization`, `reviewHire`, and `verifySettlement` return `{ ok: true, ... }` or `{ ok: false, reason, ... }`. The exact fields differ by function; see [API reference](api-reference.md).

```ts
const found = await fetchVerifiedProvider({ manifestUrl, expectedProviderDid, fetchImpl: fetch });
if (!found.ok) {
  // Example: { ok: false, reason: 'manifest_unreachable', detail: 'http 503' }
  return { stage: 'discovery', reason: found.reason };
}
// { ok: true, provider: VerifiedProvider }
```

`ok: true` means that function's stated checks passed. It does not prove that the provider will perform work or that an accepted hire has settled.

## `kind` outcomes

`submitHire` returns `accepted`, `refused`, `undelivered`, `unverifiable`, or `unbuildable`. `recoverResult` returns `opened`, `unopenable`, `unverifiable`, `no_result`, `undelivered`, `unrecognized`, or `unbuildable`. `submitSettlementHint` has its own `acknowledged`, `refused`, `undelivered`, `unrecognized`, and `unbuildable` variants.

```ts
const submitted = await submitHire(input);
switch (submitted.kind) {
  case 'accepted':
    // Authenticated acceptance; payment and delivery still need evidence.
    // Retain the original hire for settlement and result recovery.
    break;
  case 'refused':
    // Inspect the signed refusal and submitted.retryable before another action.
    break;
  case 'undelivered':
    // The response was lost. Keep the original grant and authorization.
    break;
  case 'unverifiable':
  case 'unbuildable':
    // Stop and inspect the reason or detail.
    break;
}
```

`undelivered` is uncertainty, not evidence that the operation had no effect. Retry or recover with the original identifiers according to the specific API's contract. A fresh authorization risks a second effect.

## Exceptions

| Entry point | Exception | Inspect |
| --- | --- | --- |
| `@voidly/session` | `SessionUsageError` | `code === 'session_usage_error'` for invalid use, including an inadmissible session URL. |
| `@voidly/session` | `SessionTransportError` | `code === 'session_transport_error'`, `status`, and bounded `body`; a redirect or malformed/unexpected response can refuse. |
| `@voidly/session` | `SessionCryptoUnavailableError` | `code === 'session_crypto_unavailable'`; required cryptographic primitives are absent. |
| `@voidly/session` | `RelayRefusal` | `reason` from `RelayRefusalReason`; simulation, chain, relay-window, or broadcast checks refused. |
| `@voidly/session/proofs` | `PublicExerciseError` | `code` from `PublicExerciseRefusal`, such as `exercise_invalid` or `exercise_expired`. |
| `@voidly/session/proofs-auto` | `AutomaticProofError` | `code` from `AutomaticProofErrorCode`, including `completion_uncertain` and `run_expired_or_revoked`. |
| `@voidly/session/node-files` | `LocalFileError` | `code` from `LocalFileErrorCode`; optional `bytes` reports a bounded partial-write count. |
| `@voidly/session/customer-hosted` | `HostedBuyerError` | `code` and optional `status` from fixed onboarding/consent transport. |
| `@voidly/session/customer-hosted` | `AutomaticPaymentRefusal` | `code` for a rejected policy, storage, budget, or job transition. |

Do not log private briefs, signed authorizations, completion capabilities, account tokens, or full payment/RPC URLs while handling errors.

## Payment and settlement states

`payForGrant({ grant, grantHash, nowMs, signer, facilitator })` or its `broadcast` alternative returns `{ ok: true, transactionHash, authorization, signed, preflight }` on submission. Submission is not final settlement. A refusal includes `{ ok: false, reason, detail, unsigned, preflight }`; `unsigned` identifies whether the signer had not yet produced an authorization. Preserve the original grant, authorization, and transaction evidence after an uncertain response.

`verifySettlement` is a historical chain-evidence check. A success reports `assurance.level: 'rpc-quorum-inclusion'` and leaves safe/finalized status unchecked. It does not prove provider acceptance, consent for another payment, or delivery. See the [SDK guide](../voidly-session-sdk/README.md) for the exact RPC policy and confirmation rules.
