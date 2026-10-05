# Complete `@voidly/session` export index

This is the public root-entry symbol list for package version 1.4.3. Runtime values and compile-time TypeScript types are separate. For call inputs, outcomes, and examples, use the [API reference](api-reference.md); this index is not a service-readiness claim.

Source: [`src/index.ts`](https://github.com/voidly-ai/session/blob/8123187df5f2754fc1a26051ddf7a414ec54813e/voidly-session-sdk/src/index.ts).

## [hirer](https://github.com/voidly-ai/session/blob/8123187df5f2754fc1a26051ddf7a414ec54813e/voidly-session-sdk/src/hirer.ts)

**Runtime values (12):**

- `authenticateHireAcceptance`, `buildHire`, `buildReceivePaymentAuthorization`, `buildTransferPaymentAuthorization`, `hashArtifact`, `openDeliveredResult`, `payForGrant`, `recoverResult`.
- `submitHire`, `submitSettlementHint`, `signHireAuthorization`, `verifyDeliveryReceipt`.

**TypeScript types (17):**

- `AuthenticateHireAcceptanceResult`, `BuildHireResult`, `BuildReceivePaymentResult`, `BuildTransferPaymentResult`, `HirePaymentRefusal`, `OpenDeliveredResultOutcome`, `OpenDeliveredResultRefusal`, `SignHireAuthorizationResult`.
- `PayForGrantOptions`, `PayForGrantRefusal`, `PayForGrantResult`, `RecoverResultOutcome`, `RecoverResultRefusal`, `SubmitHireResult`, `SubmitSettlementHintRefusal`, `SubmitSettlementHintResult`.
- `VerifyDeliveryResult`.

## [settlementHint](https://github.com/voidly-ai/session/blob/8123187df5f2754fc1a26051ddf7a414ec54813e/voidly-session-sdk/src/settlementHint.ts)

**Runtime values (1):**

- `buildSettlementHint`.

**TypeScript types (1):**

- `SettlementHintEnvelope`.

## [discovery](https://github.com/voidly-ai/session/blob/8123187df5f2754fc1a26051ddf7a414ec54813e/voidly-session-sdk/src/discovery.ts)

**Runtime values (4):**

- `fetchVerifiedProvider`, `PROVIDER_MANIFEST_PATH`, `checkPartiesRegistered`, `AGENT_IDENTITY_PATH_PREFIX`.

**TypeScript types (6):**

- `DiscoveryTransportReason`, `FetchVerifiedProviderInput`, `FetchVerifiedProviderResult`, `CheckPartiesRegisteredInput`, `CheckPartiesRegisteredResult`, `PartiesRegisteredRefusal`.

## [keep](https://github.com/voidly-ai/session/blob/8123187df5f2754fc1a26051ddf7a414ec54813e/voidly-session-sdk/src/keep.ts)

**Runtime values (10):**

- `persistSessionKeep`, `loadSessionKeep`, `eraseSessionKeep`, `closeOutSessionKeep`, `listSessionKeeps`, `pruneSessionKeeps`, `defaultSessionKeepDir`, `SESSION_KEEP_VERSION`.
- `SESSION_KEEP_DIR_MODE`, `SESSION_KEEP_FILE_MODE`.

**TypeScript types (6):**

- `SessionKeepFs`, `StoredSessionKeep`, `SessionKeepRecord`, `SessionKeepRefusal`, `PersistSessionKeepOutcome`, `LoadSessionKeepOutcome`.

## [settlementRetry](https://github.com/voidly-ai/session/blob/8123187df5f2754fc1a26051ddf7a414ec54813e/voidly-session-sdk/src/settlementRetry.ts)

**Runtime values (7):**

- `driveSettlementHint`, `readSessionStatus`, `classifySessionStatus`, `SESSION_STATUS_PATH_PREFIX`, `SETTLEMENT_POLL_INTERVAL_MS`, `SETTLEMENT_EXPIRY_MARGIN_MS`, `SETTLEMENT_MAX_HINT_ATTEMPTS`.

**TypeScript types (9):**

- `DriveSettlementHintInput`, `DriveSettlementHintResult`, `DriveSettlementOutcome`, `SettlementHintAttempt`, `SleepLike`, `ReadSessionStatusInput`, `ReadSessionStatusResult`, `ReadSessionStatusRefusal`.
- `SessionProgress`.

## [protocol](https://github.com/voidly-ai/session/blob/8123187df5f2754fc1a26051ddf7a414ec54813e/voidly-session-sdk/src/protocol.ts)

**Runtime values (75):**

- `isVerifiedProvider`, `PROVIDER_MANIFEST_KEYS`, `PROVIDER_MANIFEST_SCHEMA`, `verifyProvider`, `decideFromSupported`, `FACILITATOR_PREFLIGHT_SCHEMA`, `KNOWN_ASSET_TRANSFER_METHODS`, `preflightFacilitator`.
- `PREFLIGHT_DEFAULT_CHAIN`, `REQUIRED_ASSET_TRANSFER_METHOD`, `supportedUrlFor`, `X402_V1_NETWORK_ALIASES`, `AUTHORIZATION_ENTRY_POINTS`, `AUTHORIZATION_KEYS`, `authorizationEntryPoint`, `authorizationValidBeforeFor`.
- `bindAuthorizationToGrant`, `buildHireMessage`, `buildRecoveryRequest`, `canonicalBytes`, `canonicalize`, `CAPSULE_NONCE_LENGTH`, `caip2Of`, `compareDecimalStrings`.
- `deriveDidFromSigningKey`, `destroySessionKey`, `encodeSessionProviderProof`, `envelopeHash`, `exportSessionKeyBytes`, `frameBucketSize`, `importSessionKey`, `isAllZero`.
- `isCaip10`, `isCaip19`, `isCaip2`, `isPositiveDecimalString`, `isSessionParty`, `MAX_BRIEF_LENGTH`, `MAX_CLOCK_SKEW_MS`, `MAX_GRANT_TTL_MS`.
- `MAX_OFFER_TTL_MS`, `MAX_RESULT_LENGTH`, `MAX_SERVICE_REF_LENGTH`, `MIN_GRANT_TTL_MS`, `MIN_NONCE_LENGTH`, `PAYMENT_AUTHORIZATION_SCHEME`, `privateHire`, `REDEMPTION_ATTESTATION_SCHEMA`.
- `sealCapsule`, `SESSION_PROVIDER_PROOF_HEADER`, `SESSION_PROVIDER_PROOF_MAX_WINDOW_MS`, `SESSION_PROVIDER_PROOF_SCHEMA`, `sessionProviderProofEnvelope`, `SESSION_RAIL_BLOCK_TIME_MS`, `SESSION_RAIL_MIN_CONFIRMATIONS`, `SETTLEMENT_BINDING_DOMAIN`.
- `settlementBindingReference`, `sha256Hex`, `signCanonical`, `timestampMs`, `unsealBody`, `validateAcceptance`, `validateAuthorizationShape`, `validateCapsuleShape`.
- `validateGrant`, `validateOffer`, `validateRecoveryRequest`, `validateRedemptionAttestation`, `validateResultCapsuleShape`, `validateX402SessionEvidence`, `verifyDetached`, `X402_SESSION_EVIDENCE_SCHEMA`.
- `X402_SESSION_USDC_BY_CHAIN`, `x402SessionAccountCaip10`, `x402SessionAssetCaip19`.

**TypeScript types (39):**

- `ManifestRejectReason`, `ProviderManifest`, `ProviderTermsRejectReason`, `VerifiedProvider`, `VerifiedProviderRejectReason`, `VerifiedProviderVerdict`, `FacilitatorPreflightInput`, `FacilitatorPreflightResult`.
- `FetchLike`, `MatchedKind`, `PreflightObservation`, `PreflightReason`, `PreflightUndetermined`, `PreflightVerdict`, `AuthorizationEntryPoint`, `HireKeep`.
- `HireRefuseDetail`, `HireWire`, `PaymentAuthorization`, `ProviderOpenRefusal`, `ProviderOpenResult`, `RedeemRejectReason`, `RedemptionAttestation`, `SessionHireAccepted`.
- `SessionHireMessage`, `SessionHireRefused`, `SessionKey`, `SessionOfferEnvelope`, `SessionProviderProofEnvelope`, `SessionResultRejectReason`, `Signer`, `TaskAcceptanceEnvelope`.
- `TaskCapsule`, `TaskDeliveryReceipt`, `TaskGrantEnvelope`, `TaskRecoveryRequest`, `TaskResultCapsule`, `Validated`, `X402SessionEvidence`.

## [provider](https://github.com/voidly-ai/session/blob/8123187df5f2754fc1a26051ddf7a414ec54813e/voidly-session-sdk/src/provider.ts)

**Runtime values (6):**

- `acceptHire`, `buildRedemptionProofHeader`, `openBrief`, `reviewHire`, `sealTaskResult`, `signDelivery`.

**TypeScript types (3):**

- `HireTerms`, `ReviewHireRefusal`, `ReviewHireResult`.

## [payment](https://github.com/voidly-ai/session/blob/8123187df5f2754fc1a26051ddf7a414ec54813e/voidly-session-sdk/src/payment.ts)

**Runtime values (7):**

- `buildReceiveAuthorizationTypedData`, `buildTransferAuthorizationTypedData`, `EVM_USDC_EIP712_DOMAINS`, `RECEIVE_WITH_AUTHORIZATION_TYPEHASH`, `settlementNonce`, `TRANSFER_WITH_AUTHORIZATION_TYPEHASH`, `x402SessionEvidence`.

**TypeScript types (7):**

- `BuildAuthorizationInput`, `BuildReceiveAuthorizationResult`, `BuildTransferAuthorizationResult`, `EvmUsdcDomain`, `ReceiveAuthorizationTypedData`, `TransferAuthorizationRefusal`, `TransferAuthorizationTypedData`.

## [submission](https://github.com/voidly-ai/session/blob/8123187df5f2754fc1a26051ddf7a414ec54813e/voidly-session-sdk/src/submission.ts)

**Runtime values (12):**

- `buildReceiveWithAuthorizationCalldata`, `buildTransferWithAuthorizationCalldata`, `buildX402PaymentPayload`, `buildX402PaymentRequirements`, `createFacilitatorSubmitter`, `createSelfSubmitter`, `preflightAdmitsPayment`, `RECEIVE_WITH_AUTHORIZATION_SELECTOR`.
- `settleUrlFor`, `signReceiveAuthorization`, `signTransferAuthorization`, `TRANSFER_WITH_AUTHORIZATION_SELECTOR`.

**TypeScript types (19):**

- `BroadcastTx`, `BuildCalldataResult`, `CalldataRefusal`, `FacilitatorSubmitterInput`, `PaymentSubmitter`, `SelfSubmitterInput`, `SignedReceiveAuthorization`, `SignedTransferAuthorization`.
- `SignReceiveAuthorizationInput`, `SignReceiveAuthorizationResult`, `SignReceiveTypedData`, `SignRefusal`, `SignTransferAuthorizationInput`, `SignTransferAuthorizationResult`, `SignTypedData`, `SubmitRefusal`.
- `SubmitResult`, `TransactionRequest`, `X402PaymentPayload`.

## [authorization](https://github.com/voidly-ai/session/blob/8123187df5f2754fc1a26051ddf7a414ec54813e/voidly-session-sdk/src/authorization.ts)

**Runtime values (2):**

- `assembleSignedReceiveAuthorization`, `assembleSignedTransferAuthorization`.

**TypeScript types (4):**

- `AssembleAuthorizationRefusal`, `AssembleSignedReceiveAuthorizationResult`, `AssembleSignedTransferAuthorizationInput`, `AssembleSignedTransferAuthorizationResult`.

## [relay](https://github.com/voidly-ai/session/blob/8123187df5f2754fc1a26051ddf7a414ec54813e/voidly-session-sdk/src/relay.ts)

**Runtime values (12):**

- `AUTHORIZATION_USED_TOPIC0`, `checkSingleAuthorizationRelay`, `createPayeeRelayBroadcaster`, `createReadOnlyEvmRpc`, `decodeRevertReason`, `estimateRelayCost`, `FORBIDDEN_RPC_METHODS`, `READ_ONLY_RPC_METHODS`.
- `RelayRefusal`, `resolveSettlementTransaction`, `revertDataFromRpcError`, `simulateTransaction`.

**TypeScript types (14):**

- `PayeeRelayBroadcasterInput`, `ReadOnlyEvmRpc`, `ReadOnlyEvmRpcInput`, `RelayCost`, `RelayCostResult`, `RelayRefusalReason`, `ResolveSettlementTransactionInput`, `RpcRefusal`.
- `RpcResult`, `SendRelayTransaction`, `SettlementLookupResult`, `SimulationOutcome`, `SingleAuthorizationCheck`, `SingleAuthorizationRelayContext`.

## [transport](https://github.com/voidly-ai/session/blob/8123187df5f2754fc1a26051ddf7a414ec54813e/voidly-session-sdk/src/transport.ts)

**Runtime values (5):**

- `postDeliver`, `postReattest`, `postRecover`, `postRedeem`, `SESSION_PATHS`.

**TypeScript types (4):**

- `RecoverResponseBody`, `RedeemResponseBody`, `SessionEndpoint`, `SessionResponse`.

## [entropy](https://github.com/voidly-ai/session/blob/8123187df5f2754fc1a26051ddf7a414ec54813e/voidly-session-sdk/src/entropy.ts)

**Runtime values (1):**

- `webCryptoEntropy`.

**TypeScript types (1):**

- `SessionEntropy`.

## [errors](https://github.com/voidly-ai/session/blob/8123187df5f2754fc1a26051ddf7a414ec54813e/voidly-session-sdk/src/errors.ts)

**Runtime values (3):**

- `SessionCryptoUnavailableError`, `SessionTransportError`, `SessionUsageError`.

## [paymentContext](https://github.com/voidly-ai/session/blob/8123187df5f2754fc1a26051ddf7a414ec54813e/voidly-session-sdk/src/paymentContext.ts)

**Runtime values (4):**

- `createPaymentContext`, `checkPaymentSignRequest`, `verifyPaymentSignature`, `checkPaymentSubmitRequest`.

**TypeScript types (4):**

- `PaymentContext`, `PaymentContextRefusal`, `PaymentEntryPoint`, `PaymentTypedData`.

## [settlementVerification](https://github.com/voidly-ai/session/blob/8123187df5f2754fc1a26051ddf7a414ec54813e/voidly-session-sdk/src/settlementVerification.ts)

**Runtime values (1):**

- `verifySettlement`.

**TypeScript types (3):**

- `VerifySettlementInput`, `SettlementVerificationSuccess`, `SettlementVerificationResult`.
