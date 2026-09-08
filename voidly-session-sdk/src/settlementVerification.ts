import { envelopeHash, X402_SESSION_USDC_BY_CHAIN, sha256Hex, timestampMs } from "./protocol";
import { settlementNonce } from "./payment";
import { createSettlementRpc, rpcReadErrorCode } from "./settlementRpc";

const CHAIN = "eip155:8453";
const CHAIN_ID = "0x2105";
const TOKEN = X402_SESSION_USDC_BY_CHAIN.get(CHAIN)!;
const ASSET = `${CHAIN}/erc20:${TOKEN}`;
const HASH = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const QUANTITY = /^0x(0|[1-9a-f][0-9a-f]*)$/;
const BYTES = /^0x([0-9a-f]{2})*$/;
const POSITIVE = /^[1-9][0-9]{0,77}$/;
const AUTH_TOPIC = "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const GRANT_KEYS = ["schema", "hirer_did", "provider_did", "provider_signing_pubkey_base64", "provider_enc_pubkey_base64", "offer_hash", "capsule_hash", "brief_commitment", "price_chain", "price_asset", "price_payer_account", "price_payee_account", "price_min_amount", "price_max_amount", "nonce", "issued_at", "expires_at"];

export interface VerifySettlementInput {
  readonly tx: string;
  readonly grant?: unknown;
  readonly grantHash?: string;
  readonly payer?: string;
  readonly payee?: string;
  readonly amount?: string;
  readonly rpcUrls: readonly string[];
  readonly allowedRpcHosts: readonly string[];
  readonly allowUnpinnedRpc?: boolean;
  readonly minConfirmations?: number;
  readonly fetch?: typeof globalThis.fetch;
}
export interface SettlementVerificationSuccess {
  readonly ok: true;
  readonly tx: string;
  readonly grantHash: string;
  readonly nonce: string;
  readonly authorizer: string;
  readonly payer: string;
  readonly payee: string;
  readonly value: string;
  readonly authLogIndex: number;
  readonly transferLogIndex: number;
  readonly blockNumber: number;
  readonly confirmations: number;
  readonly assurance: {
    readonly level: "rpc-quorum-inclusion";
    readonly confirmationBasis: "lowest-latest-head";
    readonly safe: "not-checked";
    readonly finalized: "not-checked";
    readonly requiredConfirmations: number;
  };
  readonly chain: "0x2105";
  readonly terms: { readonly source: "typed" } | {
    readonly source: "grant"; readonly expiresAt: string;
    readonly band: { readonly min: string; readonly max: string };
  };
  readonly rpcHosts: readonly string[];
  readonly unpinnedHosts: readonly string[];
  readonly unpinned: boolean;
  readonly headOperators: number;
  readonly headFrom: string;
}
export type SettlementVerificationResult = SettlementVerificationSuccess | {
  readonly ok: false; readonly reason: string; readonly detail: string;
};
const refuse = (reason: string, detail = ""): SettlementVerificationResult => ({ ok: false, reason, detail });
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const isHash = (value: unknown): value is string => typeof value === "string" && HASH.test(value.toLowerCase());
const isQuantity = (value: unknown): value is string => typeof value === "string" && QUANTITY.test(value.toLowerCase());
const topicAddress = (value: unknown): string | null => typeof value === "string" && /^0x0{24}[0-9a-f]{40}$/.test(value.toLowerCase()) ? `0x${value.toLowerCase().slice(26)}` : null;
const inBand = (value: string, band: { min: string; max: string }) => BigInt(value) >= BigInt(band.min) && BigInt(value) <= BigInt(band.max);

function ownRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error();
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new Error();
  const out: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new Error();
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !("value" in d)) throw new Error();
    out[key] = d.value;
  }
  return out;
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error();
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<string, PropertyDescriptor>;
  const length = descriptors.length.value;
  if (Reflect.ownKeys(value).length !== length + 1) throw new Error();
  return Array.from({ length }, (_, index) => {
    const d = descriptors[String(index)];
    if (!d?.enumerable || !("value" in d) || typeof d.value !== "string") throw new Error();
    return d.value;
  });
}
function operatorKey(url: URL): string {
  const name = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (name === "localhost" || name.endsWith(".localhost") || name === "::1" || name === "::" || name === "0.0.0.0"
    || /^127\.\d+\.\d+\.\d+$/.test(name) || /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(name)
    || /^::ffff:127\.\d+\.\d+\.\d+$/.test(name) || name === "::ffff:0:0" || name === "::ffff:0.0.0.0") return "loopback";
  return name;
}
function canonicalReceipt(value: unknown, depth = 0): string {
  if (depth > 64) throw new Error();
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonicalReceipt(item, depth + 1)).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalReceipt((value as Record<string, unknown>)[key], depth + 1)}`).join(",")}}`;
}

export async function verifySettlement(input: VerifySettlementInput): Promise<SettlementVerificationResult> {
  try { return await verifyInner(input); }
  catch (error) {
    const code = rpcReadErrorCode(error);
    if (code) return refuse(code, "a selected RPC operator did not return an admitted response");
    return refuse("verifier_exception", "the verifier could not read the supplied data; underlying messages are withheld");
  }
}

async function verifyInner(input: VerifySettlementInput): Promise<SettlementVerificationResult> {
  const options = ownRecord(input);
  const keys = ["tx", "grant", "grantHash", "payer", "payee", "amount", "rpcUrls", "allowedRpcHosts", "allowUnpinnedRpc", "minConfirmations", "fetch"];
  if (Object.keys(options).some(key => !keys.includes(key))) return refuse("verifier_misconfigured");
  if (typeof options.tx !== "string" || !HASH.test(options.tx.toLowerCase().trim())) return refuse("bad_tx_hash");
  const tx = options.tx.toLowerCase().trim();
  const rpcUrls = strings(options.rpcUrls), allowedHosts = strings(options.allowedRpcHosts);
  if (rpcUrls.length === 0) return refuse("no_rpc_endpoints");
  if (options.allowUnpinnedRpc !== undefined && typeof options.allowUnpinnedRpc !== "boolean") return refuse("verifier_misconfigured");
  const required = options.minConfirmations === undefined ? 12 : options.minConfirmations;
  if (typeof required !== "number" || !Number.isSafeInteger(required) || required < 12) return refuse("verifier_misconfigured");
  const fetchImpl = options.fetch === undefined ? globalThis.fetch : options.fetch;
  if (typeof fetchImpl !== "function") return refuse("verifier_misconfigured");
  for (const key of ["grantHash", "payer", "payee", "amount"]) {
    if (options[key] !== undefined && options[key] !== null && typeof options[key] !== "string") return refuse("bad_typed_terms");
  }
  let grantHash: string, payer: string, payee: string, amount: string | null;
  let band: { min: string; max: string } | null = null;
  let terms: SettlementVerificationSuccess["terms"];
  const given = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
  if (options.grant !== undefined) {
    let grant: Record<string, unknown>;
    try { grant = ownRecord(options.grant); } catch { return refuse("grant_not_a_grant_envelope"); }
    const present = Object.keys(grant).filter(key => grant[key] !== null && grant[key] !== undefined).sort();
    if (grant.schema !== "voidly-task-grant/v1" || present.join() !== [...GRANT_KEYS].sort().join()
      || !GRANT_KEYS.every(key => typeof grant[key] === "string")
      || !Object.values(grant).every(value => value === null || value === undefined || typeof value === "string")) return refuse("grant_not_a_grant_envelope");
    if (grant.price_chain !== CHAIN) return refuse("grant_chain_not_base");
    if (grant.price_asset !== ASSET) return refuse("grant_asset_not_canonical_usdc");
    const g = grant as Record<string, string>;
    if (timestampMs(g.expires_at) === null) return refuse("grant_not_a_grant_envelope");
    const account = /^eip155:8453:0x[0-9a-f]{40}$/;
    if (!account.test(g.price_payer_account) || !account.test(g.price_payee_account)
      || !POSITIVE.test(g.price_min_amount) || !POSITIVE.test(g.price_max_amount)
      || BigInt(g.price_min_amount) > BigInt(g.price_max_amount)) return refuse("grant_not_a_grant_envelope");
    Object.freeze(grant);
    payer = g.price_payer_account.slice(CHAIN.length + 1);
    payee = g.price_payee_account.slice(CHAIN.length + 1);
    band = Object.freeze({ min: g.price_min_amount, max: g.price_max_amount });
    terms = Object.freeze({ source: "grant", expiresAt: g.expires_at, band });
    amount = null;
    if (given(options.amount)) {
      if (!/^[0-9]+$/.test(options.amount.trim())) return refuse("bad_amount");
      amount = BigInt(options.amount.trim()).toString();
      if (!inBand(amount, band)) return refuse("grant_terms_mismatch");
    }
    grantHash = await envelopeHash(grant);
    for (const [key, wanted] of [["grantHash", grantHash], ["payer", payer], ["payee", payee]]) {
      const raw = options[key];
      if (given(raw) && raw.trim().toLowerCase().replace(key === "grantHash" ? /^0x/ : /^$/, "") !== wanted) return refuse("grant_terms_mismatch");
    }
  } else {
    grantHash = typeof options.grantHash === "string" ? options.grantHash.toLowerCase().replace(/^0x/, "") : "";
    payer = typeof options.payer === "string" ? options.payer.toLowerCase() : "";
    payee = typeof options.payee === "string" ? options.payee.toLowerCase() : "";
    amount = typeof options.amount === "string" ? options.amount.trim() : "";
    if (!/^[0-9a-f]{64}$/.test(grantHash)) return refuse("bad_grant_hash");
    if (!ADDRESS.test(payer)) return refuse("bad_payer_address");
    if (!ADDRESS.test(payee)) return refuse("bad_payee_address");
    if (!/^[0-9]+$/.test(amount)) return refuse("bad_amount");
    amount = BigInt(amount).toString();
    if (amount === "0") return refuse("bad_amount");
    terms = Object.freeze({ source: "typed" });
  }
  const pinned = new Set<string>();
  for (const host of allowedHosts) {
    let url: URL;
    try { url = new URL(`https://${host}`); } catch { return refuse("rpc_policy_invalid"); }
    if (url.host !== host.toLowerCase() || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return refuse("rpc_policy_invalid");
    pinned.add(url.host);
  }
  const operators: { url: string; host: string; key: string }[] = [];
  const seen = new Set<string>();
  for (const raw of rpcUrls) {
    let url: URL;
    try { url = new URL(raw.trim()); } catch { return refuse("bad_rpc_url"); }
    if (url.protocol !== "https:") return refuse("rpc_not_https");
    if (!pinned.has(url.host) && options.allowUnpinnedRpc !== true) return refuse("rpc_host_not_allowlisted");
    const key = operatorKey(url);
    if (seen.has(key)) continue;
    seen.add(key); operators.push({ url: url.href, host: url.host, key });
  }
  if (operators.length < 2) return refuse("insufficient_rpc_quorum");
  const unpinnedHosts = Object.freeze(operators.filter(operator => !pinned.has(operator.host)).map(operator => operator.host));
  const rpc = createSettlementRpc(fetchImpl as typeof globalThis.fetch);
  for (const operator of operators) {
    const id = await rpc(operator.url, "eth_chainId", []);
    if (!isQuantity(id) || id.toLowerCase() !== CHAIN_ID) return refuse("wrong_chain");
  }
  const nonce = await settlementNonce(grantHash);
  const receipts: unknown[] = [];
  for (const operator of operators) {
    const receipt = await rpc(operator.url, "eth_getTransactionReceipt", [tx]);
    if (receipt !== null && (!isRecord(receipt) || !isHash(receipt.transactionHash) || receipt.transactionHash.toLowerCase() !== tx)) return refuse("receipt_not_for_this_tx");
    receipts.push(receipt);
  }
  let digests: string[];
  try { digests = await Promise.all(receipts.map(receipt => sha256Hex(new TextEncoder().encode(canonicalReceipt(receipt))))); }
  catch { return refuse("receipt_unparseable"); }
  if (new Set(digests).size !== 1) return refuse("rpc_divergence");
  if (receipts[0] === null) return refuse("tx_not_found");
  const receipt = receipts[0] as Record<string, unknown>;
  if (typeof receipt.status !== "string" || receipt.status.toLowerCase() !== "0x1") return refuse("tx_reverted");
  if (!Array.isArray(receipt.logs)) return refuse("receipt_logs_malformed");
  if (!isQuantity(receipt.blockNumber) || BigInt(receipt.blockNumber) > BigInt(Number.MAX_SAFE_INTEGER)) return refuse("receipt_not_mined");
  if (!isHash(receipt.blockHash)) return refuse("block_hash_unreadable");
  const blockNumber = BigInt(receipt.blockNumber), blockHash = receipt.blockHash.toLowerCase();
  type Log = { log: Record<string, unknown>; topics: string[]; index: number };
  const logs: Log[] = [];
  for (const raw of receipt.logs) {
    if (!isRecord(raw)) return refuse("log_malformed");
    if (typeof raw.address !== "string" || raw.address.toLowerCase() !== TOKEN) continue;
    if (raw.removed === true) return refuse("log_removed");
    if (raw.removed !== undefined && raw.removed !== false) return refuse("log_malformed");
    if (!isHash(raw.transactionHash) || raw.transactionHash.toLowerCase() !== tx) return refuse("log_not_for_this_tx");
    if (!isHash(raw.blockHash) || raw.blockHash.toLowerCase() !== blockHash || !isQuantity(raw.blockNumber) || BigInt(raw.blockNumber) !== blockNumber) return refuse("log_not_in_this_block");
    if (!Array.isArray(raw.topics) || raw.topics.length !== 3 || !raw.topics.every(isHash)) return refuse("log_topics_malformed");
    if (typeof raw.data !== "string" || !BYTES.test(raw.data.toLowerCase())) return refuse("log_data_malformed");
    if (!isQuantity(raw.logIndex) || BigInt(raw.logIndex) > 0xffffffffn) return refuse("log_index_unreadable");
    logs.push({ log: raw, topics: raw.topics.map(topic => topic.toLowerCase()), index: Number(BigInt(raw.logIndex)) });
  }
  logs.sort((a, b) => a.index - b.index);
  if (logs.some((log, index) => index > 0 && log.index === logs[index - 1].index)) return refuse("log_index_duplicate");
  const matchingNonce = logs.filter(log => log.topics[0] === AUTH_TOPIC && log.topics[2] === nonce);
  if (matchingNonce.length === 0) return refuse("nonce_not_spent_by_this_tx");
  const authorizations = matchingNonce.filter(log => topicAddress(log.topics[1]) === payer);
  if (authorizations.length === 0) return refuse("authorizer_mismatch");
  if (authorizations.length > 1) return refuse("authorization_ambiguous");
  const authorization = authorizations[0];
  const transfers = logs.filter(log => log.topics[0] === TRANSFER_TOPIC);
  if (transfers.length === 0) return refuse("no_usdc_transfer");
  const paired = transfers.find(log => log.index > authorization.index);
  if (!paired) return refuse("paired_transfer_missing");
  if (topicAddress(paired.topics[1]) !== payer) return refuse("transfer_payer_mismatch");
  if (topicAddress(paired.topics[2]) !== payee) return refuse("transfer_recipient_mismatch");
  if (!isHash(paired.log.data)) return refuse("transfer_value_unreadable");
  const value = BigInt(paired.log.data).toString();
  if (band && !inBand(value, band)) return refuse("amount_outside_grant_band");
  if (amount !== null && value !== amount) return refuse("exact_value");
  if (transfers.filter(log => topicAddress(log.topics[1]) === payer && topicAddress(log.topics[2]) === payee).length > 1) return refuse("transfer_ambiguous");
  for (const operator of operators) {
    const block = await rpc(operator.url, "eth_getBlockByNumber", [receipt.blockNumber, false]);
    if (block === null) return refuse("block_not_found");
    if (!isRecord(block) || !isHash(block.hash) || !isQuantity(block.number) || BigInt(block.number) !== blockNumber || block.hash.toLowerCase() !== blockHash) return refuse("block_hash_mismatch");
  }
  const heads: { host: string; height: bigint }[] = [];
  for (const operator of operators) {
    const head = await rpc(operator.url, "eth_blockNumber", []);
    if (!isQuantity(head) || BigInt(head) > BigInt(Number.MAX_SAFE_INTEGER)) return refuse("rpc_head_unreadable");
    heads.push({ host: operator.host, height: BigInt(head) });
  }
  const lowest = heads.reduce((a, b) => b.height < a.height ? b : a);
  const highest = heads.reduce((a, b) => b.height > a.height ? b : a);
  if (highest.height - lowest.height > 30n) return refuse("rpc_head_divergence");
  const confirmations = Number(lowest.height - blockNumber);
  if (confirmations < required) return refuse("insufficient_confirmations");
  return Object.freeze({ ok: true, tx, grantHash, nonce, authorizer: payer, payer, payee, value,
    authLogIndex: authorization.index, transferLogIndex: paired.index, blockNumber: Number(blockNumber), confirmations,
    assurance: Object.freeze({ level: "rpc-quorum-inclusion", confirmationBasis: "lowest-latest-head", safe: "not-checked", finalized: "not-checked", requiredConfirmations: required }),
    chain: CHAIN_ID, terms, rpcHosts: Object.freeze(operators.map(operator => operator.host)), unpinnedHosts,
    unpinned: unpinnedHosts.length > 0, headOperators: heads.length, headFrom: lowest.host });
}
