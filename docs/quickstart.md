# Quickstart

This guide targets `@voidly/session` 1.4.3. Review the exact package and source before installation. A local SDK example does not prove that a provider currently accepts paid work. For a current Voidpay payment, the human owner reviews the exact hire and signs its EIP-3009 authorization in the browser.

## Install and check locally

```bash
npm install --ignore-scripts --save-exact @voidly/session@1.4.3
node node_modules/@voidly/session/dist/proofsCli.mjs self-test
```

The Proofs CLI requires Node 20.3+. `self-test` uses a local signed fixture and makes zero network requests. Its successful response has this shape:

```json
{
  "schema": "voidly.session.self-test/v1",
  "ok": true,
  "mode": "offline",
  "checks": {
    "signed_manifest_verified": true,
    "wrong_pin_refused": true,
    "changed_manifest_refused": true,
    "canonical_digest_matches": true
  },
  "network_requests": 0,
  "saved_proof": false
}
```

The same check is available from `@voidly/session/proofs`:

```ts
import { runSessionsSelfTest } from '@voidly/session/proofs';
const check = await runSessionsSelfTest();
if (!check.ok) throw new Error('local fixture check failed');
```

An `ok: true` local fixture result does not attest installation on another machine, provider health, a paid job, or a saved proof.

## Integrate the default hire path

This is a **skeleton** for a trusted application that already has an Ed25519 identity signer and a wallet EIP-712 signer. The placeholders are caller-supplied; the example does not provide keys, a wallet, or a ready provider. In the current Voidpay flow, `signReceive` must lead to an owner-controlled browser wallet prompt for this exact payment; this skeleton is not an agent-executable checkout. Read [concepts](concepts.md) and the [SDK guide](../voidly-session-sdk/README.md) before sending an authorization.

```ts
import {
  fetchVerifiedProvider,
  buildHire,
  buildReceivePaymentAuthorization,
  submitHire,
  recoverResult,
  x402SessionAccountCaip10,
  type HireWire,
  type HireKeep,
  type PaymentAuthorization,
} from '@voidly/session';

// Application-supplied durable private storage, not an SDK export. In Node,
// implement this with persistSessionKeep for the opaque session key and a
// create-once, private, durable journal for the original signed authorization
// and endpoints. Do not JSON-serialize a SessionKey or log these records.
declare const applicationPrivateStore: {
  saveNewOriginal(input: {
    wire: HireWire; keep: HireKeep; grantHash: string;
    authorization: PaymentAuthorization;
    acceptUrl: string; sessionEndpointBaseUrl: string;
  }): Promise<void>;
};

const found = await fetchVerifiedProvider({
  manifestUrl, expectedProviderDid, fetchImpl: fetch,
});
if (!found.ok) throw new Error(found.reason);
// Success: { ok: true, provider: VerifiedProvider }

const offering = found.provider.manifest.services.find(s => s.ref === selectedServiceRef);
if (!offering) throw new Error('selected service is absent from signed manifest');
const payerAccount = x402SessionAccountCaip10(offering.price.chain, payer);
if (!payerAccount) throw new Error('unsupported payer account or chain');

const hire = await buildHire({
  hirer: { did, signingPublicKeyBase64, sign: signIdentity },
  provider: found.provider,
  service: { ref: offering.ref },
  task: { brief: approvedBrief },
  price: {
    chain: offering.price.chain,
    asset: offering.price.asset,
    payerAccount,
    payeeAccount: offering.price.payee_account,
    minAmount: offering.price.min_amount,
    maxAmount: offering.price.max_amount,
  },
  ttl: { offerMs: 30 * 60_000, grantMs: 10 * 60_000 },
  nowMs: Date.now(),
});
if (!hire.ok) throw new Error(hire.reason);
// Success: { ok: true, wire: HireWire, keep: HireKeep }

const payment = await buildReceivePaymentAuthorization({
  grant: hire.wire.grant,
  grantHash: hire.keep.grant_hash,
  nowMs: Date.now(),
  sign: signReceive, // human owner's browser wallet prompt for this exact hire
});
if (!payment.ok) throw new Error(payment.reason);
// Success: { ok: true, authorization, signed, grantHash }

// Finish a private, durable save BEFORE submitHire, the first state-changing
// network effect. If this fails, stop: a lost response must remain recoverable.
await applicationPrivateStore.saveNewOriginal({
  wire: hire.wire,
  keep: hire.keep,
  grantHash: hire.keep.grant_hash,
  authorization: payment.authorization,
  acceptUrl: found.provider.manifest.accept_url,
  sessionEndpointBaseUrl: found.provider.manifest.worker_base_url,
});

// Owner-controlled submission only; do not expose this payment step to an agent.
const submitted = await submitHire({
  url: found.provider.manifest.accept_url,
  wire: hire.wire,
  grantHash: hire.keep.grant_hash,
  authorization: payment.authorization,
  sign: signIdentity,
  nowMs: Date.now(),
  fetchImpl: fetch,
});
if (submitted.kind !== 'accepted' && submitted.kind !== 'undelivered') {
  throw new Error(submitted.kind); // Original record remains in private storage.
}
// Authenticated acceptance: { kind: 'accepted', accepted: SessionHireAccepted }
// 'undelivered' is uncertain: do not create a new hire or authorization.
// Recover the persisted original identifiers; the provider may have received it.

const read = await recoverResult({
  endpoint: { baseUrl: found.provider.manifest.worker_base_url },
  wire: hire.wire,
  grantHash: hire.keep.grant_hash,
  sessionKey: hire.keep.sessionKey,
  sign: signIdentity,
  nowMs: Date.now(),
});
if (read.kind === 'opened') {
  // Handle read.result inside the trusted application; do not log or publish it.
}
// While work is pending: { kind: 'no_result', status, outcome, state, evidence_id? }
```

The default receive authorization names the payee; the provider submits it. `accepted` is not a paid or delivered result. `saveNewOriginal` must finish durable storage before `submitHire`: preserve the wire and opaque private session key with `persistSessionKeep` (or equivalent private storage), then store the grant hash, original signed authorization, and the verified manifest's accept and session endpoint URLs in a create-once private journal. A restart must recover that original record before any retry decision. `recoverResult` can return other tagged outcomes; see [errors and refusals](errors.md).
