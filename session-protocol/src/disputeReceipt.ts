
import { isCanonicalEvidenceId, settlementBindingReference } from "./settlement";
import { canonicalBytes, envelopeHash, MAX_CLOCK_SKEW_MS } from "./envelope";
import { validateGrant } from "./grant";
import { signCanonical, verifyDetached } from "./sig";
import type { Signer } from "./sig";
import { DID_RE, HEX64_RE, hasOnlyKeys, isPlausibleNowMs, timestampMs } from "./schemas";
import type { TaskGrantEnvelope, Validated } from "./schemas";

export const SESSION_DISPUTE_RECEIPT_SCHEMA = "voidly-session-dispute-receipt/v1";

export const SESSION_DISPUTE_RECEIPT_KEYS = [
  "schema",
  "grant_hash",
  "settlement_binding_reference",
  "hirer_did",
  "provider_did",
  "finding",
  "evidence_id",
  "result_commitment",
  "observed_at",
  "limits",
] as const;

export type SessionDisputeFinding =
  | "no_journal_record"
  | "settlement_without_session"
  | "redeemed_without_result"
  | "result_committed_unverified"
  | "record_inconsistent";

const FINDINGS: readonly SessionDisputeFinding[] = [
  "no_journal_record",
  "settlement_without_session",
  "redeemed_without_result",
  "result_committed_unverified",
  "record_inconsistent",
];

export const SESSION_DISPUTE_RECEIPT_LIMITS =
  "This states only what the Voidly session rail's own journal held for this grant at observed_at. " +
  "It is NOT a refund, NOT an order to pay, NOT a finding of fault, and NOT a judgment. " +
  "This rail is verify-only: it never held the funds, never submitted the payment, and cannot compel any party. " +
  "A finding is a fact about ROWS and not about events: a redemption refused above the journal — a malformed payment pointer, a settlement adapter this deployment had not configured, a rate ceiling — leaves no row, so no_journal_record is not a finding that nobody tried. " +
  "Whether money moved is a question for the chain: recompute settlement_binding_reference from the hirer-signed grant and look it up yourself. " +
  "Finding no log is NOT proof there is none: it means no log in the range you searched, on the chain and contract you searched, on a node that still holds those logs — widen the range and use an archive node before you conclude anything from an empty result.";

export type SessionDisputeReceipt = {
  schema: typeof SESSION_DISPUTE_RECEIPT_SCHEMA;
  grant_hash: string;
  settlement_binding_reference: string;
  hirer_did: string;
  provider_did: string;
  finding: SessionDisputeFinding;
  evidence_id: string;
  result_commitment: string;
  observed_at: string;
  limits: string;
};

export type DisputeReceiptRefusal =
  | "dispute_clock_implausible"
  | "dispute_not_object"
  | "dispute_schema_mismatch"
  | "dispute_unexpected_field"
  | "dispute_invalid_grant_hash"
  | "dispute_invalid_binding_reference"
  | "dispute_invalid_hirer_did"
  | "dispute_invalid_provider_did"
  | "dispute_invalid_finding"
  | "dispute_invalid_evidence_id"
  | "dispute_invalid_result_commitment"
  | "dispute_invalid_timestamp"
  | "dispute_limits_altered"
  | "dispute_finding_field_mismatch"
  | "dispute_grant_unreadable"
  | "dispute_grant_hash_mismatch"
  | "dispute_grant_hirer_mismatch"
  | "dispute_grant_provider_mismatch"
  | "dispute_binding_reference_mismatch"
  | "dispute_hirer_key_invalid"
  | "dispute_invalid_grant_signature"
  | "dispute_attestor_key_invalid"
  | "dispute_invalid_signature"
  | "dispute_signer_failed";

const FINDING_FIELDS: Readonly<
  Record<SessionDisputeFinding, { evidence_id: boolean; result_commitment: boolean }>
> = {
  no_journal_record: { evidence_id: false, result_commitment: false },
  settlement_without_session: { evidence_id: true, result_commitment: false },
  redeemed_without_result: { evidence_id: true, result_commitment: false },
  result_committed_unverified: { evidence_id: true, result_commitment: true },
  record_inconsistent: { evidence_id: false, result_commitment: false },
};

function isFinding(value: unknown): value is SessionDisputeFinding {
  return typeof value === "string" && (FINDINGS as readonly string[]).includes(value);
}

export function validateSessionDisputeReceipt(
  raw: unknown,
  nowMs: number,
): Validated<SessionDisputeReceipt, DisputeReceiptRefusal> {
  if (!isPlausibleNowMs(nowMs)) return { ok: false, reason: "dispute_clock_implausible" };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "dispute_not_object" };
  }
  const r: Record<string, unknown> = { ...(raw as Record<string, unknown>) };

  if (r.schema !== SESSION_DISPUTE_RECEIPT_SCHEMA) {
    return { ok: false, reason: "dispute_schema_mismatch" };
  }
  if (!hasOnlyKeys(r, SESSION_DISPUTE_RECEIPT_KEYS)) {
    return { ok: false, reason: "dispute_unexpected_field" };
  }
  if (Object.keys(r).length !== SESSION_DISPUTE_RECEIPT_KEYS.length) {
    return { ok: false, reason: "dispute_unexpected_field" };
  }

  if (typeof r.grant_hash !== "string" || !HEX64_RE.test(r.grant_hash)) {
    return { ok: false, reason: "dispute_invalid_grant_hash" };
  }
  if (
    typeof r.settlement_binding_reference !== "string" ||
    !HEX64_RE.test(r.settlement_binding_reference)
  ) {
    return { ok: false, reason: "dispute_invalid_binding_reference" };
  }
  if (typeof r.hirer_did !== "string" || !DID_RE.test(r.hirer_did)) {
    return { ok: false, reason: "dispute_invalid_hirer_did" };
  }
  if (typeof r.provider_did !== "string" || !DID_RE.test(r.provider_did)) {
    return { ok: false, reason: "dispute_invalid_provider_did" };
  }
  if (!isFinding(r.finding)) return { ok: false, reason: "dispute_invalid_finding" };

  if (r.limits !== SESSION_DISPUTE_RECEIPT_LIMITS) {
    return { ok: false, reason: "dispute_limits_altered" };
  }

  const expects = FINDING_FIELDS[r.finding];

  if (typeof r.evidence_id !== "string") {
    return { ok: false, reason: "dispute_invalid_evidence_id" };
  }
  if (expects.evidence_id) {
    if (!isCanonicalEvidenceId(r.evidence_id)) {
      return { ok: false, reason: "dispute_invalid_evidence_id" };
    }
  } else if (r.evidence_id !== "") {
    return { ok: false, reason: "dispute_finding_field_mismatch" };
  }

  if (typeof r.result_commitment !== "string") {
    return { ok: false, reason: "dispute_invalid_result_commitment" };
  }
  if (expects.result_commitment) {
    if (!HEX64_RE.test(r.result_commitment)) {
      return { ok: false, reason: "dispute_invalid_result_commitment" };
    }
  } else if (r.result_commitment !== "") {
    return { ok: false, reason: "dispute_finding_field_mismatch" };
  }

  if (timestampMs(r.observed_at) === null) {
    return { ok: false, reason: "dispute_invalid_timestamp" };
  }

  return {
    ok: true,
    env: {
      schema: SESSION_DISPUTE_RECEIPT_SCHEMA,
      grant_hash: r.grant_hash,
      settlement_binding_reference: r.settlement_binding_reference,
      hirer_did: r.hirer_did,
      provider_did: r.provider_did,
      finding: r.finding,
      evidence_id: r.evidence_id,
      result_commitment: r.result_commitment,
      observed_at: r.observed_at as string,
      limits: SESSION_DISPUTE_RECEIPT_LIMITS,
    },
  };
}

export async function buildSessionDisputeReceipt(input: {
  grantHash: string;
  hirerDid: string;
  providerDid: string;
  finding: SessionDisputeFinding;
  evidenceId: string;
  resultCommitment: string;
  observedAtMs: number;
}): Promise<
  { ok: true; receipt: SessionDisputeReceipt } | { ok: false; reason: DisputeReceiptRefusal }
> {
  if (!isPlausibleNowMs(input.observedAtMs)) {
    return { ok: false, reason: "dispute_invalid_timestamp" };
  }
  if (!HEX64_RE.test(input.grantHash)) {
    return { ok: false, reason: "dispute_invalid_grant_hash" };
  }
  const receipt: SessionDisputeReceipt = {
    schema: SESSION_DISPUTE_RECEIPT_SCHEMA,
    grant_hash: input.grantHash,
    settlement_binding_reference: await settlementBindingReference(input.grantHash),
    hirer_did: input.hirerDid,
    provider_did: input.providerDid,
    finding: input.finding,
    evidence_id: input.evidenceId,
    result_commitment: input.resultCommitment,
    observed_at: new Date(input.observedAtMs).toISOString(),
    limits: SESSION_DISPUTE_RECEIPT_LIMITS,
  };
  const check = validateSessionDisputeReceipt(receipt, input.observedAtMs);
  if (!check.ok) return { ok: false, reason: check.reason };
  return { ok: true, receipt: check.env };
}

export async function signSessionDisputeReceipt(
  receipt: SessionDisputeReceipt,
  sign: Signer,
): Promise<{ ok: true; signature_base64: string } | { ok: false; reason: DisputeReceiptRefusal }> {
  const signature = await signCanonical(receipt, sign);
  if (signature === null) return { ok: false, reason: "dispute_signer_failed" };
  return { ok: true, signature_base64: signature };
}

export interface SettlementProofQuery {
  readonly chain: string;
  readonly asset: string;
  readonly payer_account: string;
  readonly payee_account: string;
  readonly authorization_nonce: string;
  readonly minimum_amount: string;
  readonly not_before: string;
  readonly not_after: string;
  readonly how: string;
}

const AUTHORIZATION_USED_SIGNATURE = "AuthorizationUsed(address,bytes32)";
const AUTHORIZATION_USED_DECLARATION =
  "AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)";
const AUTHORIZATION_CANCELED_SIGNATURE = "AuthorizationCanceled(address,bytes32)";

export function settlementProofQuery(
  grant: TaskGrantEnvelope,
  bindingReference: string,
): SettlementProofQuery {
  const issuedMs = timestampMs(grant.issued_at);
  const notBefore =
    issuedMs === null ? grant.issued_at : new Date(issuedMs - MAX_CLOCK_SKEW_MS).toISOString();
  const expiresMs = timestampMs(grant.expires_at);
  const notAfter =
    expiresMs === null
      ? grant.expires_at
      : // The token compares SECONDS, and `authorizationValidBeforeFor` floors.
        new Date(Math.floor(expiresMs / 1000) * 1000).toISOString();
  return {
    chain: grant.price_chain,
    asset: grant.price_asset,
    payer_account: grant.price_payer_account,
    payee_account: grant.price_payee_account,
    authorization_nonce: `0x${bindingReference}`,
    minimum_amount: grant.price_min_amount,
    not_before: notBefore,
    not_after: notAfter,
    how:
      `On ${grant.price_chain}, ask any archive node you trust for logs from the token ` +
      `contract in ${grant.price_asset}, with topic0 = keccak256("${AUTHORIZATION_USED_SIGNATURE}") ` +
      `— the CANONICAL signature, no parameter names and no "indexed"; the ABI declares it as ` +
      `${AUTHORIZATION_USED_DECLARATION} and keccak of THAT string matches nothing — topic1 = the ` +
      `address in ${grant.price_payer_account} left-padded to 32 bytes, and topic2 = ` +
      `0x${bindingReference}. A log means the hirer's authorization for THIS grant was consumed; ` +
      `read the ERC-20 Transfer in that same transaction to see the amount and the payee, and ` +
      `compare them against payee_account and minimum_amount above. ` +
      `keccak256("${AUTHORIZATION_CANCELED_SIGNATURE}") on the same (authorizer, nonce) pair means ` +
      `the authorization was burned without paying. ` +
      `RANGE: not_before and not_after are TIMESTAMPS and eth_getLogs takes BLOCK NUMBERS, so ` +
      `convert them yourself — round fromBlock DOWN and toBlock UP — and note that public RPCs ` +
      `cap a single eth_getLogs at a few thousand blocks, so you will page. ` +
      `not_after is enforced by the token contract itself and is a real upper bound for the USED ` +
      `event; not_before is only a HINT, because it comes from the hirer's clock and the block ` +
      `timestamp comes from the chain's. ` +
      `FINDING NO LOG IS NOT PROOF THERE IS NONE. It means no log in the range you searched, on ` +
      `the chain and contract named here, on a node that still holds those logs. Widen the range ` +
      `and use an archive node before you conclude anything from an empty result.`,
  };
}

export interface DisputeReceiptVerification {
  readonly receipt: SessionDisputeReceipt;
  readonly grant: TaskGrantEnvelope;
  readonly settlement_proof_query: SettlementProofQuery;
  readonly established: readonly string[];
  readonly not_established: readonly string[];
}

export async function verifySessionDisputeReceipt(input: {
  receipt: unknown;
  signatureBase64: string;
  attestorSigningPublicKey: Uint8Array;
  grant: unknown;
  grantSignatureBase64: string;
  hirerSigningPublicKey: Uint8Array;
  nowMs: number;
}): Promise<
  { ok: true; verification: DisputeReceiptVerification } | { ok: false; reason: DisputeReceiptRefusal }
> {
  const structural = validateSessionDisputeReceipt(input.receipt, input.nowMs);
  if (!structural.ok) return { ok: false, reason: structural.reason };
  const receipt = structural.env;

  if (
    !(input.attestorSigningPublicKey instanceof Uint8Array) ||
    input.attestorSigningPublicKey.length !== 32
  ) {
    return { ok: false, reason: "dispute_attestor_key_invalid" };
  }
  if (
    !(input.hirerSigningPublicKey instanceof Uint8Array) ||
    input.hirerSigningPublicKey.length !== 32
  ) {
    return { ok: false, reason: "dispute_hirer_key_invalid" };
  }

  const grantCheck = validateGrant(input.grant, input.nowMs);
  if (!grantCheck.ok) return { ok: false, reason: "dispute_grant_unreadable" };
  const grant = grantCheck.env;

  if ((await envelopeHash(grant)) !== receipt.grant_hash) {
    return { ok: false, reason: "dispute_grant_hash_mismatch" };
  }
  if (grant.hirer_did !== receipt.hirer_did) {
    return { ok: false, reason: "dispute_grant_hirer_mismatch" };
  }
  if (grant.provider_did !== receipt.provider_did) {
    return { ok: false, reason: "dispute_grant_provider_mismatch" };
  }
  if ((await settlementBindingReference(receipt.grant_hash)) !== receipt.settlement_binding_reference) {
    return { ok: false, reason: "dispute_binding_reference_mismatch" };
  }

  if (!verifyDetached(grant, input.grantSignatureBase64, input.hirerSigningPublicKey)) {
    return { ok: false, reason: "dispute_invalid_grant_signature" };
  }

  if (!verifyDetached(receipt, input.signatureBase64, input.attestorSigningPublicKey)) {
    return { ok: false, reason: "dispute_invalid_signature" };
  }

  const query = settlementProofQuery(grant, receipt.settlement_binding_reference);
  return {
    ok: true,
    verification: {
      receipt,
      grant,
      settlement_proof_query: query,
      established: [
        "The grant verifies under the hirer key you supplied, so — to the extent that key really is this hirer's — its accounts, asset, chain and price band are the hirer's own terms.",
        "The Voidly session rail signed this receipt under the key you pinned, and it is about THIS grant.",
        `As of ${receipt.observed_at}, that rail's journal held: ${receipt.finding}.`,
        "The settlement binding reference recomputes from the grant, so the chain query below is for this hire and no other.",
      ],
      not_established: [
        "Whether money moved. Nothing in this document proves that — run settlement_proof_query yourself.",
        "What was presented to this rail and refused. A redemption can be turned away above the journal — a malformed payment pointer, an unconfigured settlement adapter, a rate ceiling — and leave no row, so a finding of no_journal_record is not a finding that nobody tried.",
        "Whether the provider delivered anything outside this rail. Voidly cannot see email, sockets, or any other channel.",
        "Whether any result is correct, complete, or openable. The rail holds no session key and never sees plaintext.",
        "Who is at fault. This document is evidence, not a judgment, and the rail has no power to compel anyone.",
      ],
    },
  };
}
