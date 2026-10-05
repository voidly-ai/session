# Subpath API reference

These are the public entry points alongside `@voidly/session`. Import from the stated path; importing an internal `src/` file is unsupported. Examples show contracts and illustrative data, not a claim about current provider availability or a live payment. See [errors](errors.md) for shared handling rules.

| Entry point | Purpose |
| --- | --- |
| [`@voidly/session/break-even`](#break-even) | Derive a relay floor from chain facts in the paid asset's smallest unit. |
| [`@voidly/session/proofs`](#public-proofs) | Check a public exercise and signed provider manifest, or run an offline self-test. |
| [`@voidly/session/proofs-auto`](#owner-preauthorized-proofs) | Complete one owner-preauthorized, nonpayment Proofs handoff. |
| [`@voidly/session/node-files`](#bounded-node-file-io) | Read a bounded local file and create a new verified file. |
| [`@voidly/session/customer-hosted`](#customer-hosted-owner-approved-jobs) | Optional owner-approved buyer consent and locally budgeted jobs. |

## Break-even

Import from `@voidly/session/break-even`.

### Pure calculation and checks

`RelayCostFacts` contains `gasPriceWei`, `gasUnits`, `l1DataFeeWei`, and `nativeUsd` as `bigint`, plus `nativeUsdDecimals` and `assetDecimals` as numbers. Amounts returned by this module are in the paid asset's **smallest unit**. For USDC, `assetDecimals` is 6. No price, gas quote, or chain condition in this example is current market data.

```ts
import {
  breakEvenSmallestUnits, relayFloorSmallestUnits,
  checkConfiguredFloor, checkOfferedAmount, WIRE_MULTIPLE,
  type RelayCostFacts,
} from '@voidly/session/break-even';

const facts: RelayCostFacts = {
  gasPriceWei: 1_000_000_000n,
  gasUnits: 100n,
  l1DataFeeWei: 0n,
  nativeUsd: 3000_00000000n,
  nativeUsdDecimals: 8,
  assetDecimals: 6,
};
breakEvenSmallestUnits(facts);                      // 300n
relayFloorSmallestUnits(facts, WIRE_MULTIPLE);       // 900n
checkConfiguredFloor({ configuredMinAmount: '900', facts, multiple: WIRE_MULTIPLE });
// { ok: true }
checkOfferedAmount({ amount: '800', facts, multiple: WIRE_MULTIPLE });
// { ok: false, reason: 'price_below_break_even', detail: '...' }
checkOfferedAmount({ amount: '900', facts, multiple: WIRE_MULTIPLE });
// { ok: true, floor: 900n }
```

`breakEvenSmallestUnits(facts): bigint` rounds the asset cost up. `relayFloorSmallestUnits(facts, multiple): bigint` multiplies that amount and throws for a nonpositive multiple. `checkConfiguredFloor({configuredMinAmount,facts,multiple})` returns `{ok:true}` or `{ok:false,reason:'configured_min_amount_below_break_even',detail}`. `checkOfferedAmount({amount,facts,multiple})` returns `{ok:true,floor}` or `{ok:false,reason:'price_below_break_even',detail}`. Both amount inputs are decimal strings; malformed values refuse.

The exported constants are `RELAY_GAS_UNITS = 102_883n`, `WIRE_MULTIPLE = 3n`, `QUOTE_MULTIPLE = 12n`, `GAS_PRICE_ORACLE` (OP Stack predeploy address), and `CHAINLINK_ETH_USD_BASE` (Base ETH/USD feed address). The measured gas unit count and multiples are policy inputs, not live quotes. `RELAY_GAS_UNITS`, `WIRE_MULTIPLE`, and `QUOTE_MULTIPLE` must not be read as a guarantee of profitability.

### Read chain facts

`readRelayCostFacts` takes a `ReadOnlyEvmRpc`, a signed raw transaction hex string, a feed address, a caller chosen clock and maximum feed age, gas units, and asset decimals. It reads `eth_gasPrice`, the OP GasPriceOracle L1 fee, and Chainlink price data. It returns a `FactsResult`; a failed read cannot be treated as a zero fee.

```ts
import {
  readRelayCostFacts, CHAINLINK_ETH_USD_BASE, RELAY_GAS_UNITS,
  type FactsResult,
} from '@voidly/session/break-even';
import type { ReadOnlyEvmRpc } from '@voidly/session';

declare const rpc: ReadOnlyEvmRpc;
declare const signedRawTransactionHex: string;
const result: FactsResult = await readRelayCostFacts({
  rpc,
  rawTransactionHex: signedRawTransactionHex,
  priceFeed: CHAINLINK_ETH_USD_BASE,
  nowSeconds: BigInt(Math.floor(Date.now() / 1000)),
  maxPriceAgeSeconds: 3600n, // choose an age for your own operating policy
  gasUnits: RELAY_GAS_UNITS,
  assetDecimals: 6,
});
if (result.ok) {
  // { ok: true, facts: RelayCostFacts, updatedAtSeconds: bigint }
  console.log(result.facts.gasUnits);
} else {
  // { ok: false, reason: BreakEvenRefusal, detail: string }
  console.error(result.reason);
}
```

`BreakEvenRefusal` can be `gas_price_unreadable`, `l1_fee_unreadable`, `native_price_unreadable`, `native_price_not_positive`, or `native_price_stale`. `BreakEvenResult`, `ConfiguredFloorVerdict`, `OfferedAmountVerdict`, and `FactsResult` are exported result types. `readRelayCostFacts` has no default for `maxPriceAgeSeconds`; choose it explicitly. Reading cost facts does not sign or broadcast the transaction.

## Public Proofs

Import from `@voidly/session/proofs`. This exercise checks public discovery and signature behavior. It requires no wallet and makes no payment. The exported provider pair is fixed exercise data; it is not a current capacity or availability assertion.

```ts
import {
  runSessionsSelfTest, parsePublicExercise, runPublicExercise,
  verifyPublicExercise, proofArtworkSvg, PublicExerciseError,
  type PublicExercise,
} from '@voidly/session/proofs';

const selfTest = await runSessionsSelfTest();
// { schema: 'voidly.session.self-test/v1', ok: true, mode: 'offline',
//   checks: { signed_manifest_verified: true, wrong_pin_refused: true,
//     changed_manifest_refused: true, canonical_digest_matches: true },
//   network_requests: 0, saved_proof: false }

declare const exerciseJsonFromOwner: string;
const exercise: PublicExercise = parsePublicExercise(exerciseJsonFromOwner);
// PublicExercise fields: schema, task, challenge_id, challenge,
// issued_at, expires_at, provider. Extra fields and stale challenges refuse.

const result = await runPublicExercise(exerciseJsonFromOwner);
// { schema: PUBLIC_RESULT_SCHEMA, task, challenge_id, challenge,
//   manifest_digest_sha256, challenge_response_sha256,
//   checks: { provider_pair_listed: true, manifest_verified: true,
//     wrong_pin_refused: true } }

declare const publicIndex: unknown;
declare const signedManifest: unknown;
const calculated = await verifyPublicExercise(exercise, publicIndex, signedManifest);
// Same PublicExerciseResult shape; pure evidence calculation, with no save.

const artworkSvg = proofArtworkSvg('0123456789abcdef0123456789abcdef');
// SVG string for a 32-character lowercase hex ID.

try { parsePublicExercise(exerciseJsonFromOwner); }
catch (error) {
  if (error instanceof PublicExerciseError) console.error(error.code);
}
```

`runPublicExercise(text, {fetchImpl?, nowMs?})` fetches a fixed public provider index and signed manifest. `verifyPublicExercise(exercise,index,manifest,nowMs?)` calculates the same public result from supplied data. `parsePublicExercise(text,nowMs?)` enforces an exact JSON shape and a ten minute challenge lifetime. `proofArtworkSvg(id)` throws for a malformed ID. A result checks the specified exercise; it does not install a provider or save a Proofs record.

Public constants: `PUBLIC_EXERCISE_SCHEMA`, `PUBLIC_RESULT_SCHEMA`, `PUBLIC_RESPONSE_SCHEMA`, `SESSIONS_PROOFS_TASK`, `SESSIONS_PROOFS_PROVIDER`, `PUBLIC_EXERCISE_MAX_BYTES = 8192`, and `PUBLIC_EXERCISE_TTL_MS = 600000`. Public types: `PublicExercise`, `PublicExerciseResult`, and `PublicExerciseRefusal`. `PublicExerciseError.code` can be `exercise_invalid`, `exercise_expired`, `provider_not_listed`, `manifest_invalid`, `wrong_pin_not_refused`, `upstream_unavailable`, `upstream_redirect`, `upstream_too_large`, or `upstream_not_json`.

## Owner-preauthorized Proofs

Import from `@voidly/session/proofs-auto`. This is one owner-preauthorized, bounded **Proofs save**. It has an explicit `STOP` payment boundary and offers no reward. A handoff includes a completion capability; treat the entire handoff as a secret. Do not print it, put it in an issue, or include a real value in sample code.

```ts
import {
  parseAutomaticHandoff, completeAutomaticProof, AutomaticProofError,
  AUTOMATIC_BOUNDARY, type VerifiedAutomaticProof,
} from '@voidly/session/proofs-auto';

declare const handoffFromPrivateOwnerChannel: string;
const parsed = parseAutomaticHandoff(handoffFromPrivateOwnerChannel);
// { schema: AUTOMATIC_HANDOFF_SCHEMA, run_id: string,
//   completion_capability: string } — keep this object private.
const completed: VerifiedAutomaticProof = await completeAutomaticProof(handoffFromPrivateOwnerChannel);
// { schema: 'voidly.session.automatic-proof/v1', ok: true,
//   saved_proof: true, event_id, visibility, already_completed,
//   receipt, artwork: { recipe, seed, svg, sha256 },
//   return_url: 'https://voidly.ai/pay/proofs', payment_boundary: 'STOP' }
console.log(completed.event_id, completed.payment_boundary);
console.log(AUTOMATIC_BOUNDARY.decision); // 'STOP'
```

`parseAutomaticHandoff(text)` accepts only exact `{schema,run_id,completion_capability}` JSON, capped at `AUTOMATIC_HANDOFF_MAX_BYTES = 1024`. `completeAutomaticProof(text,{fetchImpl?,nowMs?})` runs the offline self-test, uses fixed service endpoints for the original handoff, checks the result against the issuer's signing keys, and returns a signed `AutomaticReceipt` within `VerifiedAutomaticProof`. An uncertain completion must be recovered with the **original** handoff rather than a new save request. This call contacts the Proofs service; use it only with an owner-authorized handoff.

Exported constants: `AUTOMATIC_HANDOFF_SCHEMA`, `AUTOMATIC_TASK`, `AUTOMATIC_BASE`, `AUTOMATIC_ISSUER`, `AUTOMATIC_RECEIPT_DOMAIN`, `AUTOMATIC_RUN_BINDING_DOMAIN`, `AUTOMATIC_SCOPE`, `AUTOMATIC_HANDOFF_MAX_BYTES`, and `AUTOMATIC_BOUNDARY`. Exported types: `AutomaticHandoff`, `AutomaticProofErrorCode`, `AutomaticReceipt`, and `VerifiedAutomaticProof`. `AutomaticProofError.code` can be `handoff_invalid`, `self_test_failed`, `response_invalid`, `issuer_invalid`, `receipt_invalid`, `completion_unavailable`, `completion_uncertain`, `permission_refused`, `run_expired_or_revoked`, `rate_limited`, `attempts_exhausted`, or `provider_check_failed`.

## Bounded Node file I/O

Import from `@voidly/session/node-files`. These are synchronous Node operations on caller-owned paths. They refuse symlinks and observed file replacement, and errors omit file contents and paths. They do not claim to protect against another process running as the same user or guarantee physical durability on every filesystem.

```ts
import {
  readFileCapped, writeNewVerifiedFile, LocalFileError,
} from '@voidly/session/node-files';

const bytes = readFileCapped('/private/owned/input.json', 8192, { requirePrivate: true });
// Buffer with at most 8192 bytes; throws LocalFileError on failure.
writeNewVerifiedFile('/private/owned/new-result.json', Buffer.from('{"ok":true}'));
// void; creates a new 0600 file, verifies it and syncs file and parent.
// Existing targets refuse with code 'exists'; do not blindly retry with a new name.

try { readFileCapped('/private/owned/input.json', 8192, { requirePrivate: true }); }
catch (error) {
  if (error instanceof LocalFileError) console.error(error.code, error.bytes);
}
```

`readFileCapped(path,cap,{requirePrivate?,ops?})` accepts a cap from 1 byte through 1 MiB. `writeNewVerifiedFile(path,bytes,{aliases?,ops?})` accepts a `Buffer` of at most 2 MiB and create-once semantics. `aliases` are additional names checked during the verified write. `LocalFileOps` is the injectable filesystem interface for deterministic fault tests; production uses Node `fs`. `LocalFileErrorCode` is `permissions`, `unsupported`, `read`, `too_large`, `limit`, `symlink`, `not_regular`, `changed`, `close`, `moved`, `exists`, `verify`, `write`, `mode`, or `sync`. `LocalFileError` exposes `code` and optional bounded `bytes`.

## Customer-hosted owner-approved jobs

Import from `@voidly/session/customer-hosted`. This optional path requires Node 24.15+ on Linux or macOS and a persistent private directory. It is distinct from a hosted provider service's current readiness. The owner must review the exact service, selected inputs, limits, and expiry. A hosted setup records intent; it does **not** grant wallet control or unattended payment authority. In the current Voidpay flow, each payment requires the human owner's browser review and signature. Do not give an agent the wallet signer or payment submission path.

### Buyer setup and consent

`BuyerConsentSession` is `{accessToken,isCurrent:()=>boolean,signal:AbortSignal}`. Acquire it from your own authenticated owner flow and keep the token private. The adapters use fixed Voidly paths and require a current session.

```ts
import {
  createHostedBuyerAdapter, createAuthenticatedBuyerConsentAdapter,
  type BuyerConsentSession,
} from '@voidly/session/customer-hosted';

declare const ownerSession: BuyerConsentSession;
declare const requestId: string;
declare const payerAccount: string;    // eip155:8453:0x... owner account
declare const definitionDigest: string; // 64 lowercase hex characters
declare const selectedText: string;     // owner-selected input only

const setup = createHostedBuyerAdapter(ownerSession);
const readiness = await setup.readiness();
// { kind: 'setup-required', checkoutReady: false, ..., walletControlVerified: false,
//   unattendedPayments: false, authorization: 'wallet-per-job' }
// or { kind: 'checkout-ready', checkoutReady: true, permissionId, ...,
//        walletControlVerified: false, unattendedPayments: false }
const prior = await setup.read();                 // HostedBuyerSetup | null
const begun = await setup.begin({ requestId, payerAccount, definitionDigest });
// HostedBuyerSetup; paymentAuthorityGranted: false, checkoutReady: false.

const consent = createAuthenticatedBuyerConsentAdapter(ownerSession);
const reviewed = await consent.reviewScope({ requestId, selectedText });
// BuyerConsentSnapshot { review: BuyerConsentReview, reviewDigest, approval: null }
const approved = await consent.approveScope({
  reviewId: reviewed.review.reviewId, reviewDigest: reviewed.reviewDigest, requestId,
});
// BuyerConsentSnapshot with approval, only after the owner reviews exact scope.
const saved = await consent.readScope({ requestId }); // BuyerConsentSnapshot | null
```

`createHostedBuyerAdapter(session,transport?)` returns `HostedBuyerAdapter` with `readiness()`, `read()`, and `begin(input:HostedBuyerBegin)`. `createAuthenticatedBuyerConsentAdapter(session,transport?)` returns `BuyerConsentAdapter` with `reviewScope`, `approveScope`, and `readScope`. The exported types are `HostedBuyerReadiness`, `HostedBuyerSetup`, `HostedBuyerBegin`, `BuyerConsentReview`, `BuyerConsentSnapshot`, and `BuyerConsentSession`. `HostedBuyerError` reports `code` and optional HTTP `status`; an uncertain `begin` outcome must be looked up with the original request ID. The consent adapter may report an `OUTCOME_UNKNOWN` after a sent request; read the original request rather than creating a second approval.

### Finite local policy

`createCustomerHostedJobs` validates an owner-reviewed `AutomaticHostedJobPolicy`, an authenticated `CheckoutSession`, an EIP-1193 wallet provider, and a private local journal. Policy inputs are exact byte digests and lengths, time bounds, per-job and total atom caps, and maximum concurrent jobs. The code below is a contract illustration after those prerequisites are met; `run` can request an EIP-1193 signature and submit payment. Keep it in an owner-controlled application with an owner-present browser wallet prompt for each current payment.

```ts
import {
  createCustomerHostedJobs,
  type AutomaticHostedJobPolicy, type CheckoutSession, type Eip1193Provider,
} from '@voidly/session/customer-hosted';

declare const ownerReviewedPolicy: AutomaticHostedJobPolicy;
declare const checkoutSession: CheckoutSession;
declare const walletProvider: Eip1193Provider;
declare const operationId: string;
declare const selectedText: string;
const jobs = createCustomerHostedJobs({
  directory: '/private/owned/voidly-journal', policy: ownerReviewedPolicy,
  session: checkoutSession, provider: walletProvider,
});
// Owner-controlled application only; do not expose run to an agent.
const outcome = await jobs.run({ operationId, selectedText });
// CustomerHostedJobOutcome.kind: 'original-recovery', 'recover-original',
// 'submitted' (payment: 'unconfirmed'), or 'refused'.
const original = await jobs.recover(operationId); // CustomerHostedJobRecovery
const budget = jobs.status();
// { policyId, revoked, committedAtoms, attempts, maxTotalAtoms }
jobs.revoke(); // no more new runs
jobs.close();  // close local journal
```

`submitted` does not establish settlement or delivered work. On `recover-original` or uncertainty, use `recover(operationId)` and retain the original identifiers. Do not replace the input or operation ID to bypass a failed attempt. `CustomerHostedJobs`, `CustomerHostedJobOutcome`, and `CustomerHostedJobRecovery` are exported types. `AutomaticPaymentRefusal.code` identifies rejected policy, storage, budget, identity, or job state.

### Finite owner app program

`parseOwnerAppProgram(value:unknown): OwnerAppProgram` checks the exact owner app program shape and binding. `createCustomerHostedProgramJobs` additionally requires an approved program, a private signing credential, current lifetime, wallet provider, and private journal. The program accepts only preapproved input digests and a finite budget. The example deliberately omits credential values. This published API can call the wallet provider and submit payment; current Voidpay checkout does not authorize unattended agent use.

```ts
import {
  parseOwnerAppProgram, createCustomerHostedProgramJobs,
  type OwnerAppProgramCredential, type ProgramLifetime, type Eip1193Provider,
} from '@voidly/session/customer-hosted';

declare const programResponse: unknown;
declare const privateCredential: OwnerAppProgramCredential;
declare const ownerLifetime: ProgramLifetime;
declare const walletProvider: Eip1193Provider;
declare const ownerSelectedText: string;
declare const approvedInputDigest: string;
const program = parseOwnerAppProgram(programResponse);
const programJobs = createCustomerHostedProgramJobs({
  directory: '/private/owned/voidly-program-journal',
  program, credential: privateCredential, lifetime: ownerLifetime,
  provider: walletProvider,
});
// Owner-controlled application only; do not expose run to an agent.
const outcome = await programJobs.run({ selectedText: ownerSelectedText });
// CustomerHostedJobOutcome: inspect kind; 'submitted' is unconfirmed.
const original = await programJobs.recover(approvedInputDigest);
// CustomerHostedJobRecovery for this original input digest.
const budget = programJobs.status();
programJobs.revoke();
programJobs.close();
```

Public types here are `CustomerHostedProgramJobs`, `OwnerAppProgram`, `OwnerAppProgramScope`, `OwnerAppProgramCredential`, and `ProgramLifetime`. Program credentials and access tokens must stay out of logs and docs. A parsed or approved program does not by itself authorize a wallet signature; the EIP-1193 provider remains part of each payment attempt.
