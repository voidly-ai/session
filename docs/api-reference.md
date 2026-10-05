# `@voidly/session` API reference

This page covers the **root package entry** in version 1.4.3. The package also exposes [five subpath APIs](subpaths.md). The [complete export index](export-index.md) lists every runtime value and TypeScript-only name; tables here focus on callable behavior. Example variables such as `grant`, `wire`, `sign`, and `rpc` are already validated, caller-supplied values. The output snippets are representative discriminated branches, not promises of a live provider or successful payment. In the current Voidpay flow, a human owner reviews and signs each payment in the browser; caller-supplied signing APIs do not grant unattended agent authority.

## Discover and verify

The signed manifest, not an index listing, supplies service and price terms. Keep an explicit provider DID pin.

| Function | Example request | Example result |
| --- | --- | --- |
| `fetchVerifiedProvider` | `await fetchVerifiedProvider({ manifestUrl, expectedProviderDid, fetchImpl: fetch })` | `{ ok: true, provider }` or `{ ok: false, reason: 'manifest_unreachable', detail: 'http 503' }` |
| `checkPartiesRegistered` | `await checkPartiesRegistered({ registryBaseUrl, hirerDid, providerDid, hirerSigningPublicKeyBase64, fetchImpl: fetch })` | `{ ok: true }` or `{ ok: false, reason: 'hirer_unregistered', detail }` |
| `verifyProvider` | `verifyProvider(rawManifest, expectedProviderDid)` | `{ ok: true, provider }` or `{ ok: false, reason }` |
| `isVerifiedProvider` | `isVerifiedProvider(candidate)` | `true` only for a provider object minted by the verifier; otherwise `false` |

`PROVIDER_MANIFEST_PATH`, `AGENT_IDENTITY_PATH_PREFIX`, `PROVIDER_MANIFEST_SCHEMA`, and `PROVIDER_MANIFEST_KEYS` describe the fixed wire paths and manifest shape. They are exported data, not network calls.

## Hirer: build, authorize, submit, recover

See the [quickstart](quickstart.md) for the default receive-authorization sequence. `accepted` authenticates a hire response; it does not mean settled or delivered.

| Function | Example request | Example result |
| --- | --- | --- |
| `buildHire` | `await buildHire({ hirer, provider, service: { ref }, task: { brief }, price, ttl, nowMs })` | `{ ok: true, wire, keep }` or `{ ok: false, reason }` |
| `buildReceivePaymentAuthorization` | `await buildReceivePaymentAuthorization({ grant, grantHash, nowMs, sign: signReceive })` | `{ ok: true, authorization, signed, grantHash }` or `{ ok: false, reason, detail }` |
| `buildTransferPaymentAuthorization` | `await buildTransferPaymentAuthorization({ grant, grantHash, nowMs, sign: signTransfer })` | Same tagged shape as the receive variant, with a transfer authorization. The two are alternatives. |
| `signHireAuthorization` | `await signHireAuthorization({ grant, grantHash, authorization, sign })` | `{ ok: true, authorizationSignatureBase64 }` or `{ ok: false, reason, detail }` |
| `submitHire` | `await submitHire({ url, wire, grantHash, authorization, sign, nowMs, fetchImpl: fetch })` | `{ kind: 'accepted', accepted }`, `{ kind: 'refused', refused, retryable, steersPayment }`, or `undelivered`/`unverifiable`/`unbuildable` |
| `authenticateHireAcceptance` | `await authenticateHireAcceptance({ raw, grant, grantHash, nowMs })` | `{ ok: true, accepted }` or `{ ok: false, reason }` |
| `recoverResult` | `await recoverResult({ endpoint, wire, grantHash, sessionKey, sign, nowMs })` | `{ kind: 'opened', result, receipt }`, `{ kind: 'no_result', status, outcome, state }`, or another tagged outcome |
| `verifyDeliveryReceipt` | `verifyDeliveryReceipt({ receipt, signatureBase64, grant, grantHash, nowMs })` | `{ ok: true, receipt }` or `{ ok: false, reason }` |
| `openDeliveredResult` | `await openDeliveredResult({ receipt, signatureBase64, resultCapsule, grant, grantHash, sessionKey, nowMs })` | `{ kind: 'opened', result, receipt }`, `{ kind: 'unopenable', receipt }`, or `{ kind: 'unverifiable', reason }` |
| `hashArtifact` | `await hashArtifact(wire.grant)` | Lowercase SHA-256 envelope hash string |

`buildReceivePaymentAuthorization` asks the caller's wallet signer to sign EIP-712 data. It performs grant and authorization self-checks first. The private `keep` contains recovery material and must be retained securely; never log or publish it.

## Payment submission and settlement hints

The alternate transfer path requires **exactly one** of `facilitator` or `broadcast`. A submitted transaction hash is not final settlement evidence.

| Function | Example request | Example result |
| --- | --- | --- |
| `payForGrant` | `await payForGrant({ grant, grantHash, nowMs, signer, facilitator: { baseUrl, fetchImpl: fetch } })` | `{ ok: true, transactionHash, authorization, signed, preflight }` or `{ ok: false, reason, detail, unsigned, preflight }` |
| `buildSettlementHint` | `await buildSettlementHint({ grantHash, providerDid, evidence, nowMs })` | `SettlementHintEnvelope` carrying the evidence hash, grant/provider identity, and time |
| `submitSettlementHint` | `await submitSettlementHint({ provider, grant, grantHash, evidence, sign, nowMs, fetchImpl: fetch })` | `{ kind: 'acknowledged', status, hint }`, `refused`, `undelivered`, `unrecognized`, or `unbuildable` |
| `readSessionStatus` | `await readSessionStatus({ statusBaseUrl, grantHash, fetchImpl: fetch })` | `{ ok: true, status }` or `{ ok: false, reason, detail }` |
| `classifySessionStatus` | `classifySessionStatus('accepted')` | `'unpaid'` (`SessionProgress`) |
| `driveSettlementHint` | `await driveSettlementHint({ hintUrl, statusBaseUrl, grant, grantHash, evidence, sign, now, sleep, fetchImpl: fetch })` | `{ ok, outcome, attempts, lastStatus, detail }`; `outcome` may be `settled`, `provider_relaying`, or a refusal/budget state |

`SESSION_STATUS_PATH_PREFIX`, `SETTLEMENT_POLL_INTERVAL_MS`, `SETTLEMENT_EXPIRY_MARGIN_MS`, and `SETTLEMENT_MAX_HINT_ATTEMPTS` are exported defaults/limits. Re-drive only the original hire, within its authorization window.

## Provider-side builders and validators

The provider daemon's admission policy, execution, and settlement decision are outside this package. These functions validate and construct protocol objects; they do not accept a job on a hosted service by themselves.

| Function | Example request | Example result |
| --- | --- | --- |
| `reviewHire` | `await reviewHire({ wire, expectedProviderDid, hirerSigningPublicKey, nowMs })` | `{ ok: true, offer, grant, capsule, grantHash, capsuleHash, offerHash, terms }` or `{ ok: false, reason }` |
| `acceptHire` | `await acceptHire({ grantHash, providerDid, sign, nowMs })` | `{ ok: true, acceptance, signature_base64 }` or `{ ok: false, reason }` |
| `buildRedemptionProofHeader` | `await buildRedemptionProofHeader({ providerDid, grantHash, sign, nowMs })` | `{ name, value }` header pair |
| `openBrief` | `await openBrief({ wire, attestation, attestationSignatureBase64, attestorSigningPublicKey, hirerSigningPublicKey, providerDid, recipientEncSecretKey, nowMs })` | `{ kind: 'opened', brief, sessionKey }`, `{ kind: 'refused', reason }`, or `{ kind: 'unopenable' }` |
| `sealTaskResult` | `await sealTaskResult({ result, grantHash, sessionKey, briefCapsule })` | `{ capsule, resultCommitment, resultCapsuleHash }` |
| `signDelivery` | `await signDelivery({ grantHash, offerHash, providerDid, resultCapsuleHash, resultCommitment, recoverableUntilMs, nowMs, sign })` | `{ ok: true, receipt, signature_base64 }` or `{ ok: false, reason }` |

## Keep files and lifecycle

These helpers use a caller-supplied `SessionKeepFs` file-system adapter. `persistSessionKeep` writes private recovery material; set its parent directory permissions and retention policy deliberately. The separate `node-files` entry has bounded file primitives.

| Function | Example request | Example result |
| --- | --- | --- |
| `defaultSessionKeepDir` | `defaultSessionKeepDir('/home/owner')` | `'/home/owner/.voidly/sessions'` |
| `persistSessionKeep` | `await persistSessionKeep({ fs, dir, grantHash, endpointBaseUrl, wire, sessionKey, nowMs })` | `{ ok: true, path }` or `{ ok: false, reason }` |
| `loadSessionKeep` | `await loadSessionKeep({ fs, dir, grantHash })` | `{ ok: true, keep, path }` or `{ ok: false, reason: 'not_found' }` |
| `listSessionKeeps` | `listSessionKeeps({ fs, dir })` | Sorted array of stored grant hashes, or `[]` |
| `eraseSessionKeep` | `eraseSessionKeep({ fs, dir, grantHash })` | `{ ok: true, erased: boolean }` or `{ ok: false, reason }` |
| `pruneSessionKeeps` | `pruneSessionKeeps({ fs, dir, nowMs, recoveryTtlMs })` | `{ erased: string[], kept: string[] }` |
| `closeOutSessionKeep` | `closeOutSessionKeep({ fs, dir, grantHash, sessionKey })` | `{ ok: true, erased }` or `{ ok: false, reason }`; destroys the in-memory session key |

`SESSION_KEEP_VERSION`, `SESSION_KEEP_DIR_MODE`, and `SESSION_KEEP_FILE_MODE` are exported format and permission constants. Deleting a keep before the original job is recoverable can lose access to its result.

## EIP-3009 authorization and x402 facilitator helpers

Use Unix **seconds** for `validAfter`/`validBefore` in low-level EIP-712 builders, but Unix **milliseconds** for `nowMs`. The high-level hire payment builders derive their money fields from the signed grant. Low-level helpers require the caller to enforce the surrounding policy.

| Function | Example request | Example result |
| --- | --- | --- |
| `settlementNonce` | `await settlementNonce(grantHash)` | `0x` followed by 64 lowercase hex characters, derived from the grant hash |
| `buildReceiveAuthorizationTypedData` | `await buildReceiveAuthorizationTypedData({ chain, from, to, value, validAfter: 0, validBefore, grantHash })` | `{ ok: true, typedData: { primaryType: 'ReceiveWithAuthorization', domain, types, message } }` or `{ ok: false, reason }` |
| `buildTransferAuthorizationTypedData` | `await buildTransferAuthorizationTypedData({ chain, from, to, value, validAfter: 0, validBefore, grantHash })` | `{ ok: true, typedData: { primaryType: 'TransferWithAuthorization', domain, types, message } }` or `{ ok: false, reason }` |
| `signReceiveAuthorization` | `await signReceiveAuthorization({ chain, from, to, value, validAfter, validBefore, grantHash, nowMs }, signReceive)` | `{ ok: true, signed }` or `{ ok: false, reason, detail }` |
| `signTransferAuthorization` | `await signTransferAuthorization({ chain, from, to, value, validAfter, validBefore, grantHash, nowMs }, signTransfer)` | `{ ok: true, signed }` or `{ ok: false, reason, detail }` |
| `assembleSignedReceiveAuthorization` | `await assembleSignedReceiveAuthorization({ authorization, grant, nowMs, expectedGrantHash: grantHash })` | `{ ok: true, signed, grantHash }` or `{ ok: false, reason, detail }` |
| `assembleSignedTransferAuthorization` | `await assembleSignedTransferAuthorization({ authorization, grant, nowMs, expectedGrantHash: grantHash })` | `{ ok: true, signed, grantHash }` or `{ ok: false, reason, detail }` |
| `buildReceiveWithAuthorizationCalldata` | `buildReceiveWithAuthorizationCalldata(signedReceive)` | `{ ok: true, request: { to, data, value: '0x0', chainId } }` or `{ ok: false, reason, detail }` |
| `buildTransferWithAuthorizationCalldata` | `buildTransferWithAuthorizationCalldata(signedTransfer)` | Same `BuildCalldataResult` shape for the transfer selector |
| `buildX402PaymentPayload` | `buildX402PaymentPayload(signedTransfer, matched)` after checking `preflight.matched !== null` | `{ x402Version, scheme: 'exact', network, payload: { signature, authorization } }` |
| `buildX402PaymentRequirements` | `buildX402PaymentRequirements(signedTransfer, matched)` after the same check | Requirements record with `scheme`, `network`, `payTo`, `asset`, and version-dependent `amount`/`maxAmountRequired` |
| `x402SessionEvidence` | `x402SessionEvidence(transactionHash)` | `{ schema: X402_SESSION_EVIDENCE_SCHEMA, transaction_hash: transactionHash }`; malformed hashes throw `RangeError` |
| `createFacilitatorSubmitter` | `createFacilitatorSubmitter({ preflight, fetchImpl: fetch })` | `{ kind: 'facilitator', submit(signed): Promise<SubmitResult> }` |
| `createSelfSubmitter` | `createSelfSubmitter({ broadcast })` | `{ kind: 'self', submit(signed): Promise<SubmitResult> }` |
| `preflightAdmitsPayment` | `preflightAdmitsPayment(preflight, false)` | `true` or `false`; unknown/unadvertised cases require explicit policy |
| `settleUrlFor` | `settleUrlFor('https://facilitator.example')` | HTTPS `/settle` URL or `null` |

The x402 payload builders construct data for an explicitly matched facilitator path. They do not advertise or prove a live paid HTTP resource. A preflight result cannot establish on-chain transaction shape, batching behavior, or stock-client nonce control.

## Read-only RPC, relay, and settlement verification

`createReadOnlyEvmRpc` rejects methods outside `READ_ONLY_RPC_METHODS`; `FORBIDDEN_RPC_METHODS` documents prohibited write calls. Relay broadcasters and payment submitters are separate, explicitly supplied effects.

| Function | Example request | Example result |
| --- | --- | --- |
| `createReadOnlyEvmRpc` | `createReadOnlyEvmRpc({ url: rpcUrl, fetchImpl: fetch })` | `{ url, request(method, params): Promise<RpcResult> }` |
| `simulateTransaction` | `await simulateTransaction({ rpc, request, from })` | `{ kind: 'would_succeed', returned }`, `{ kind: 'would_revert', reason, raw }`, or `{ kind: 'unavailable', detail }` |
| `estimateRelayCost` | `await estimateRelayCost({ rpc, request, from, gasLimitMarginPercent: 20 })` | `{ ok: true, cost: { gas, gasLimit, gasPriceWei, maxCostWei, relayerBalanceWei } }` or `{ ok: false, reason, detail }` |
| `checkSingleAuthorizationRelay` | `checkSingleAuthorizationRelay(request, context)` | `{ ok: true }` or `{ ok: false, detail }` |
| `createPayeeRelayBroadcaster` | `createPayeeRelayBroadcaster({ rpc, relayerAddress, send })` | A `broadcast(request)` function returning a transaction hash or throwing `RelayRefusal` |
| `resolveSettlementTransaction` | `await resolveSettlementTransaction({ rpc, chainId, authorizer, bindingReference, fromBlock })` | `{ kind: 'found', transactionHash, blockNumber }`, `not_consumed`, `impossible`, or `unavailable` |
| `decodeRevertReason` | `decodeRevertReason(revertData)` | Decoded reason string or `null` |
| `revertDataFromRpcError` | `revertDataFromRpcError(errorDetail)` | Revert-data hex string or `null` |
| `verifySettlement` | `await verifySettlement({ tx, grant, rpcUrls, allowedRpcHosts })` | `{ ok: true, tx, nonce, confirmations, assurance, ... }` or `{ ok: false, reason, detail }` |

`verifySettlement` checks a historical Base USDC transaction against the grant and every selected RPC operator. Its successful `assurance.level` is `rpc-quorum-inclusion`; `safe` and `finalized` are both `not-checked`. It is not permission to make another payment. Use independently selected HTTPS RPC hosts and follow the [SDK guide](../voidly-session-sdk/README.md) for the exact confirmation and host policy.

## Facilitator preflight

Preflight reads `/supported` and decides whether the advertised exact payment scheme and asset match the Session rail. It does not settle a payment.

| Function | Example request | Example result |
| --- | --- | --- |
| `supportedUrlFor` | `supportedUrlFor('https://facilitator.example')` | HTTPS `/supported` URL or `null` |
| `preflightFacilitator` | `await preflightFacilitator({ baseUrl, chain, fetchImpl: fetch })` | `FacilitatorPreflightResult` with `verdict: 'usable' \| 'unusable' \| 'unknown'`, `reason`, `matched`, and `undetermined` |
| `decideFromSupported` | `decideFromSupported({ body: supportedJson, chain, url, httpStatus: 200 })` | Same result type from a supplied `/supported` body; no network request |

`FACILITATOR_PREFLIGHT_SCHEMA`, `PREFLIGHT_DEFAULT_CHAIN`, `REQUIRED_ASSET_TRANSFER_METHOD`, `KNOWN_ASSET_TRANSFER_METHODS`, and `X402_V1_NETWORK_ALIASES` are exported protocol constants. The `undetermined` list explains what `/supported` cannot establish.

## Raw session HTTP doors

These are low-level posts for a provider/session implementation. The default hirer path uses `submitHire` and `recoverResult`; use raw doors only when the application also validates their wire objects and responses. `SessionEndpoint` supplies `baseUrl`, optional `fetch`, and optional `timeoutMs`.

| Function | Example request | Example result |
| --- | --- | --- |
| `postRedeem` | `await postRedeem(endpoint, { wire, acceptance, acceptanceSignatureBase64, evidence, proofHeader })` | `{ status, body: RedeemResponseBody }` or `SessionTransportError` |
| `postDeliver` | `await postDeliver(endpoint, { wire, receipt, receiptSignatureBase64, resultCapsule })` | `{ status, body }` or `SessionTransportError` |
| `postRecover` | `await postRecover(endpoint, { wire, request, requestSignatureBase64 })` | `{ status, body: RecoverResponseBody }` or `SessionTransportError` |
| `postReattest` | `await postReattest(endpoint, { wire, proofHeader })` | `{ status, body }` or `SessionTransportError` |

`SESSION_PATHS` names the fixed redeem, deliver, recover, and reattest paths. Do not interpret an HTTP success alone as signed settlement or delivery evidence.

## Payment context guard

These functions let a trusted app retain one exact payment context across the wallet callback and broadcast boundary. They do not provide consent, authenticate a provider, or submit funds.

| Function | Example request | Example result |
| --- | --- | --- |
| `createPaymentContext` | `await createPaymentContext({ grant, entryPoint: 'receive_with_authorization' })` | `{ ok: true, context }` or `{ ok: false, reason }` |
| `checkPaymentSignRequest` | `checkPaymentSignRequest({ context, typedData })` | `{ ok: true, typedData }` or `{ ok: false, reason }` |
| `verifyPaymentSignature` | `verifyPaymentSignature({ context, signature })` | `{ ok: true, signature }` or `{ ok: false, reason }` |
| `checkPaymentSubmitRequest` | `checkPaymentSubmitRequest({ context, signature, request })` | `{ ok: true, request }` or `{ ok: false, reason }` |

The context is immutable and valid only in the SDK instance that created it. It is not a serializable approval token. The caller still chooses when to ask the wallet to sign and whether to broadcast.

## Entropy

| Function | Example request | Example result |
| --- | --- | --- |
| `webCryptoEntropy` | `const entropy = webCryptoEntropy(); entropy.random(32); entropy.nonce()` | 32 random bytes and a 32-character lowercase hex nonce |

`webCryptoEntropy()` returns a `SessionEntropy` implementation backed by WebCrypto. An unavailable WebCrypto primitive raises `SessionCryptoUnavailableError`. Applications can inject `SessionEntropy` into builders for controlled tests; do not reuse deterministic test entropy for real hires.

## Wire builders, canonicalization, and signatures

These lower-level functions are exported from the shared protocol through the root entry. They are useful for custom carriers and validators; the higher-level `buildHire`, `submitHire`, and `recoverResult` compose the usual order and checks. `Validated<T>` returns `{ ok: true, env }` or `{ ok: false, reason }`.

| Function | Example request | Example result |
| --- | --- | --- |
| `privateHire` | `await privateHire({ hirer, provider, service, task, price, ttl, nowMs, entropy })` | `{ ok: true, wire, keep }` or `{ ok: false, reason }`; caller supplies every entropy field |
| `buildHireMessage` | `await buildHireMessage(wire, authorization, sign)` | `{ ok: true, env: SessionHireMessage }` or `{ ok: false, reason }` |
| `buildRecoveryRequest` | `await buildRecoveryRequest({ grantHash, requesterDid, actionNonce, nowMs, ttlMs, sign })` | `{ ok: true, request, signature_base64 }` or `{ ok: false, reason }` |
| `sealCapsule` | `await sealCapsule({ brief, offerHash, recipientEncPublicKey, sessionKeyBytes, ephemeralSecretKey, briefSalt, bodyNonce, wrapNonce })` | `{ capsule, sessionKey, briefCommitment }`; invalid key lengths throw |
| `unsealBody` | `await unsealBody(capsule, sessionKey)` | `{ kind: 'opened', bytes, payload }` or `{ kind: 'unopenable' }` |
| `sessionProviderProofEnvelope` | `sessionProviderProofEnvelope({ providerDid, grantHash, actionNonce, nowMs })` | `SessionProviderProofEnvelope` |
| `encodeSessionProviderProof` | `encodeSessionProviderProof(envelope, signatureBase64)` | Base64-encoded proof header value |
| `canonicalize` | `canonicalize({ a: 1 })` | Canonical JSON string |
| `canonicalBytes` | `canonicalBytes({ a: 1 })` | UTF-8 `Uint8Array` of the canonical encoding |
| `envelopeHash` | `await envelopeHash(grant)` | Lowercase 64-character SHA-256 hex digest |
| `sha256Hex` | `await sha256Hex(new TextEncoder().encode('example'))` | Lowercase 64-character SHA-256 hex digest |
| `signCanonical` | `await signCanonical(envelope, sign)` | Detached signature as Base64 string, or `null` if signing fails |
| `verifyDetached` | `verifyDetached(envelope, signatureBase64, publicKeyBytes)` | `true` or `false` |
| `deriveDidFromSigningKey` | `deriveDidFromSigningKey(signingPublicKeyBytes)` | `did:voidly:...` string derived from the key bytes |
| `frameBucketSize` | `frameBucketSize(100)` | `512` bytes; larger sizes round up by powers of two |

`sessionProviderProofEnvelope` is only an envelope builder: the caller must sign and encode it. `sealCapsule` is a primitive with explicit nonces and keys, not a replacement for provider verification or owner payment consent.

## Grant, authorization, and identity utilities

| Function | Example request | Example result |
| --- | --- | --- |
| `authorizationEntryPoint` | `authorizationEntryPoint(authorization)` | `'receive_with_authorization'`, `'transfer_with_authorization'`, or `'unstated'` |
| `authorizationValidBeforeFor` | `authorizationValidBeforeFor(grant)` | Unix-seconds decimal string or `null` |
| `bindAuthorizationToGrant` | `await bindAuthorizationToGrant(authorization, grant, grantHash)` | `null` when bound; otherwise a `HireRefuseDetail` reason |
| `settlementBindingReference` | `await settlementBindingReference(grantHash)` | Lowercase 64-character hash used as the payment binding nonce source |
| `x402SessionAccountCaip10` | `x402SessionAccountCaip10(chain, address)` | Canonical CAIP-10 account string or `null` |
| `x402SessionAssetCaip19` | `x402SessionAssetCaip19(chain)` | Frozen USDC CAIP-19 asset string or `null` |
| `caip2Of` | `caip2Of(caip10OrCaip19)` | CAIP-2 chain string or `null` |
| `isCaip2` | `isCaip2('eip155:8453')` | `true` |
| `isCaip10` | `isCaip10(account)` | `true` or `false` |
| `isCaip19` | `isCaip19(asset)` | `true` or `false` |
| `isPositiveDecimalString` | `isPositiveDecimalString('5')` | `true` |
| `compareDecimalStrings` | `compareDecimalStrings('5', '10')` | `-1`, `0`, `1`, or `null` for invalid input |
| `isSessionParty` | `isSessionParty(candidate)` | Type-guard boolean |
| `isAllZero` | `isAllZero(new Uint8Array(32))` | `true` |
| `timestampMs` | `timestampMs('2026-10-04T00:00:00.000Z')` | Epoch milliseconds or `null` |
| `importSessionKey` | `importSessionKey(keyBytes)` | Opaque `SessionKey`; wrong length throws |
| `exportSessionKeyBytes` | `exportSessionKeyBytes(sessionKey)` | Copy of 32 key bytes or `null` after destruction |
| `destroySessionKey` | `destroySessionKey(sessionKey)` | `void`; zeros and forgets the held key bytes |

`AUTHORIZATION_ENTRY_POINTS`, `AUTHORIZATION_KEYS`, `PAYMENT_AUTHORIZATION_SCHEME`, `SETTLEMENT_BINDING_DOMAIN`, `X402_SESSION_USDC_BY_CHAIN`, and the CAIP/payload constants are exported reference data. Use the functions above to validate user input and derive canonical forms.

## Validate untrusted wire data

Do not treat a parsed JSON object as a signed grant. Run the relevant validator and signature/binding checks before admitting it. Each `Validated` success returns `env`; refusals carry a named `reason`.

| Function | Example request | Example result |
| --- | --- | --- |
| `validateOffer` | `validateOffer(rawOffer, nowMs)` | `{ ok: true, env: SessionOfferEnvelope }` or `{ ok: false, reason }` |
| `validateGrant` | `validateGrant(rawGrant, nowMs)` | `{ ok: true, env: TaskGrantEnvelope }` or `{ ok: false, reason }` |
| `validateAcceptance` | `validateAcceptance(rawAcceptance, nowMs)` | `{ ok: true, env: TaskAcceptanceEnvelope }` or `{ ok: false, reason }` |
| `validateAuthorizationShape` | `validateAuthorizationShape(rawAuthorization)` | `{ ok: true, env: PaymentAuthorization }` or `{ ok: false, reason }` |
| `validateCapsuleShape` | `validateCapsuleShape(rawCapsule)` | `{ ok: true, env: TaskCapsule }` or `{ ok: false, reason }` |
| `validateResultCapsuleShape` | `validateResultCapsuleShape(rawResultCapsule)` | `{ ok: true, env: TaskResultCapsule }` or `{ ok: false, reason }` |
| `validateRecoveryRequest` | `validateRecoveryRequest(rawRequest, nowMs)` | `{ ok: true, env: TaskRecoveryRequest }` or `{ ok: false, reason }` |
| `validateRedemptionAttestation` | `validateRedemptionAttestation(rawAttestation, nowMs)` | `{ ok: true, env: RedemptionAttestation }` or `{ ok: false, reason }` |
| `validateX402SessionEvidence` | `validateX402SessionEvidence(rawEvidence)` | `X402SessionEvidence` object or `null` |

These shape/time validators do not each authenticate every signature or establish that on-chain settlement occurred. Compose them with the relevant signature, grant-binding, provider, and chain-evidence checks.
