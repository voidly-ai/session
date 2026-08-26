
import {
  SETTLEMENT_BINDING_DOMAIN,
  X402_SESSION_EVIDENCE_SCHEMA,
  X402_SESSION_USDC_BY_CHAIN,
  isCaip10,
  isPositiveDecimalString,
  settlementBindingReference,
} from "./protocol";
import type { X402SessionEvidence } from "./protocol";

const HEX64_RE = /^[0-9a-f]{64}$/;
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export async function settlementNonce(grantHash: string): Promise<`0x${string}`> {
  if (typeof grantHash !== "string" || !HEX64_RE.test(grantHash)) {
    throw new RangeError("settlementNonce: grantHash must be 64-char lowercase hex");
  }
  const ref = await settlementBindingReference(grantHash);
  return `0x${ref}` as const;
}

export interface EvmUsdcDomain {
  readonly name: string;
  readonly version: string;
  readonly chainId: number;
  readonly verifyingContract: string;
  readonly domainSeparator: string;
}

export const EVM_USDC_EIP712_DOMAINS: ReadonlyMap<string, EvmUsdcDomain> = Object.freeze(
  new Map<string, EvmUsdcDomain>([
    [
      "eip155:8453",
      Object.freeze({
        name: "USD Coin",
        version: "2",
        chainId: 8453,
        verifyingContract: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        domainSeparator: "0x02fa7265e7c5d81118673727957699e4d68f74cd74b7db77da710fe8a2c7834f",
      }),
    ],
    [
      "eip155:84532",
      Object.freeze({
        name: "USDC",
        version: "2",
        chainId: 84532,
        verifyingContract: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
        domainSeparator: "0x71f17a3b2ff373b803d70a5a07c046c1a2bc8e89c09ef722fcb047abe94c9818",
      }),
    ],
  ]),
);

/**
 * The `TransferWithAuthorization` struct hash.
 *
 * Present so a caller can assert its signing library is hashing the SAME
 * struct this module describes.
 *
 * The field ORDER in `types` is load-bearing: EIP-712 encodes members
 * positionally, so reordering them changes the hash and the contract refuses
 * a signature that looks entirely valid.
 */
export const TRANSFER_WITH_AUTHORIZATION_TYPEHASH =
  "0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267";

export interface TransferAuthorizationTypedData {
  readonly domain: {
    readonly name: string;
    readonly version: string;
    readonly chainId: number;
    readonly verifyingContract: string;
  };
  readonly types: {
    readonly EIP712Domain: ReadonlyArray<{ readonly name: string; readonly type: string }>;
    readonly TransferWithAuthorization: ReadonlyArray<{
      readonly name: string;
      readonly type: string;
    }>;
  };
  readonly primaryType: "TransferWithAuthorization";
  readonly message: {
    readonly from: string;
    readonly to: string;
    readonly value: string;
    readonly validAfter: string;
    readonly validBefore: string;
    readonly nonce: string;
  };
}

export type BuildTransferAuthorizationResult =
  | { ok: true; typedData: TransferAuthorizationTypedData }
  | { ok: false; reason: TransferAuthorizationRefusal };

export const RECEIVE_WITH_AUTHORIZATION_TYPEHASH =
  "0xd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de8";

export interface ReceiveAuthorizationTypedData {
  readonly domain: {
    readonly name: string;
    readonly version: string;
    readonly chainId: number;
    readonly verifyingContract: string;
  };
  readonly types: {
    readonly EIP712Domain: ReadonlyArray<{ readonly name: string; readonly type: string }>;
    readonly ReceiveWithAuthorization: ReadonlyArray<{
      readonly name: string;
      readonly type: string;
    }>;
  };
  readonly primaryType: "ReceiveWithAuthorization";
  readonly message: {
    readonly from: string;
    readonly to: string;
    readonly value: string;
    readonly validAfter: string;
    readonly validBefore: string;
    readonly nonce: string;
  };
}

export type BuildReceiveAuthorizationResult =
  | { ok: true; typedData: ReceiveAuthorizationTypedData }
  | { ok: false; reason: TransferAuthorizationRefusal };

export type TransferAuthorizationRefusal =
  | "unsupported_chain"
  | "invalid_from"
  | "invalid_to"
  | "invalid_value"
  | "invalid_validity_window"
  | "validity_looks_like_milliseconds"
  | "invalid_grant_hash";

function evmAddress(value: string, chain: string): string | null {
  if (typeof value !== "string") return null;
  if (EVM_ADDRESS_RE.test(value)) return value.toLowerCase();
  if (isCaip10(value)) {
    const prefix = `${chain}:`;
    if (!value.startsWith(prefix)) return null;
    const addr = value.slice(prefix.length);
    return EVM_ADDRESS_RE.test(addr) ? addr.toLowerCase() : null;
  }
  return null;
}

export interface BuildAuthorizationInput {
  chain: string;
  from: string;
  to: string;
  value: string;
  /** UNIX SECONDS. 0 is the ordinary choice. */
  validAfter: number;
  /** UNIX SECONDS. Must exceed validAfter. */
  validBefore: number;
  grantHash: string;
}

/**
 * The six EIP-712 members, in the ORDER the struct hash is computed over.
 *
 * ONE ARRAY, READ BY BOTH VARIANTS. The members and their order are identical
 * in `TransferWithAuthorization` and `ReceiveWithAuthorization`.
 *
 * DO NOT SORT THESE ALPHABETICALLY. EIP-712 encodes members positionally.
 */
const EIP3009_AUTHORIZATION_MEMBERS = Object.freeze([
  Object.freeze({ name: "from", type: "address" }),
  Object.freeze({ name: "to", type: "address" }),
  Object.freeze({ name: "value", type: "uint256" }),
  Object.freeze({ name: "validAfter", type: "uint256" }),
  Object.freeze({ name: "validBefore", type: "uint256" }),
  Object.freeze({ name: "nonce", type: "bytes32" }),
]);

const EIP712_DOMAIN_MEMBERS = Object.freeze([
  Object.freeze({ name: "name", type: "string" }),
  Object.freeze({ name: "version", type: "string" }),
  Object.freeze({ name: "chainId", type: "uint256" }),
  Object.freeze({ name: "verifyingContract", type: "address" }),
]);

async function buildAuthorizationParts(input: BuildAuthorizationInput): Promise<
  | {
      ok: true;
      domain: {
        readonly name: string;
        readonly version: string;
        readonly chainId: number;
        readonly verifyingContract: string;
      };
      message: {
        readonly from: string;
        readonly to: string;
        readonly value: string;
        readonly validAfter: string;
        readonly validBefore: string;
        readonly nonce: string;
      };
    }
  | { ok: false; reason: TransferAuthorizationRefusal }
> {
  const domain = EVM_USDC_EIP712_DOMAINS.get(input.chain);
  if (!domain) return { ok: false, reason: "unsupported_chain" };

  const adapterToken = X402_SESSION_USDC_BY_CHAIN.get(input.chain);
  if (adapterToken !== domain.verifyingContract) return { ok: false, reason: "unsupported_chain" };

  const from = evmAddress(input.from, input.chain);
  if (!from) return { ok: false, reason: "invalid_from" };
  const to = evmAddress(input.to, input.chain);
  if (!to) return { ok: false, reason: "invalid_to" };

  if (!isPositiveDecimalString(input.value)) return { ok: false, reason: "invalid_value" };

  if (
    !Number.isInteger(input.validAfter) ||
    !Number.isInteger(input.validBefore) ||
    input.validAfter < 0 ||
    input.validBefore <= input.validAfter
  ) {
    return { ok: false, reason: "invalid_validity_window" };
  }
  if (input.validBefore > 1e12 || input.validAfter > 1e12) {
    return { ok: false, reason: "validity_looks_like_milliseconds" };
  }

  if (typeof input.grantHash !== "string" || !HEX64_RE.test(input.grantHash)) {
    return { ok: false, reason: "invalid_grant_hash" };
  }
  const nonce = await settlementNonce(input.grantHash);

  return {
    ok: true,
    domain: {
      name: domain.name,
      version: domain.version,
      chainId: domain.chainId,
      verifyingContract: domain.verifyingContract,
    },
    message: {
      from,
      to,
      value: input.value,
      validAfter: String(input.validAfter),
      validBefore: String(input.validBefore),
      nonce,
    },
  };
}

/**
 * Build the EIP-712 payload for `transferWithAuthorization`.
 *
 * `validAfter` and `validBefore` are UNIX SECONDS — EIP-3009 compares them
 * against `block.timestamp`. Every other time value in this client is
 * milliseconds, so this is the one place the unit changes, and it changes
 * silently: no type catches it. A `validBefore` above 1e12 is refused by its
 * own named reason rather than signed.
 *
 * An authorization signed under this struct may be relayed by ANYONE. A payee
 * that will relay the payment itself should be handed the receive variant —
 * see `buildReceiveAuthorizationTypedData`.
 */
export async function buildTransferAuthorizationTypedData(
  input: BuildAuthorizationInput,
): Promise<BuildTransferAuthorizationResult> {
  const parts = await buildAuthorizationParts(input);
  if (!parts.ok) return { ok: false, reason: parts.reason };
  return {
    ok: true,
    typedData: {
      domain: parts.domain,
      types: {
        EIP712Domain: EIP712_DOMAIN_MEMBERS,
        // ORDER IS PART OF THE HASH. Do not sort these alphabetically.
        TransferWithAuthorization: EIP3009_AUTHORIZATION_MEMBERS,
      },
      primaryType: "TransferWithAuthorization",
      message: parts.message,
    },
  };
}

export async function buildReceiveAuthorizationTypedData(
  input: BuildAuthorizationInput,
): Promise<BuildReceiveAuthorizationResult> {
  const parts = await buildAuthorizationParts(input);
  if (!parts.ok) return { ok: false, reason: parts.reason };
  return {
    ok: true,
    typedData: {
      domain: parts.domain,
      types: {
        EIP712Domain: EIP712_DOMAIN_MEMBERS,
        // ORDER IS PART OF THE HASH. Do not sort these alphabetically.
        ReceiveWithAuthorization: EIP3009_AUTHORIZATION_MEMBERS,
      },
      primaryType: "ReceiveWithAuthorization",
      message: parts.message,
    },
  };
}

export function x402SessionEvidence(transactionHash: string): X402SessionEvidence {
  if (typeof transactionHash !== "string" || !/^0x[0-9a-f]{64}$/.test(transactionHash)) {
    throw new RangeError(
      "x402SessionEvidence: transaction hash must be `0x` + 64 LOWERCASE hex. " +
        "Case matters: canonicalEvidenceId folds hex to lowercase, and one hash " +
        "with its case flipped was two evidence ids — one payment buying two tasks.",
    );
  }
  return { schema: X402_SESSION_EVIDENCE_SCHEMA, transaction_hash: transactionHash };
}

export { SETTLEMENT_BINDING_DOMAIN };
