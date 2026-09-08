import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashArtifact, settlementNonce, verifySettlement } from "../src/index";
import { auth, BLOCK_HASH, fetchServing, grant, grantReceipt, GRANT_HASH, honest, HOSTS, OTHER, PAYER, PAYEE, quantity, receipt, TOKEN, topic, transfer, TYPED, TX, URLS, word } from "./_settlementFixtures";
import type { SettlementVerificationResult, VerifySettlementInput } from "../src/index";
function refused(result: SettlementVerificationResult, reason: string) { expect(result.ok).toBe(false); if (!result.ok) expect(result.reason).toBe(reason); }
async function run(document: unknown, input: Partial<VerifySettlementInput> = {}, modify?: Parameters<typeof fetchServing>[1]) {
  const served = fetchServing(document, modify);
  const result = await verifySettlement({ ...TYPED, ...input, fetch: served.fetch });
  return { result, calls: served.calls };
}
beforeEach(() => vi.stubGlobal("fetch", async () => { throw new Error("unexpected external fetch"); }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("all selected operators and honest assurance", () => {
  it("corroborates each read at every selected operator and reports only latest-head inclusion", async () => {
    const rpcUrls = [...URLS, "https://rpc-c.example.test/key"];
    const { result, calls } = await run(await honest(), { rpcUrls, allowedRpcHosts: rpcUrls.map(url => new URL(url).host) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result).toMatchObject({ tx: TX, grantHash: GRANT_HASH, payer: PAYER, authorizer: PAYER, payee: PAYEE, value: "50000", authLogIndex: 0, transferLogIndex: 1, blockNumber: 256, confirmations: 12,
      assurance: { level: "rpc-quorum-inclusion", confirmationBasis: "lowest-latest-head", safe: "not-checked", finalized: "not-checked", requiredConfirmations: 12 },
      chain: "0x2105", terms: { source: "typed" }, unpinned: false, unpinnedHosts: [], headOperators: 3, headFrom: HOSTS[0] });
    for (const url of rpcUrls) expect(calls.filter(call => call.url === url).map(call => call.method)).toEqual(["eth_chainId", "eth_getTransactionReceipt", "eth_getBlockByNumber", "eth_blockNumber"]);
    expect(calls.filter(call => call.method === "eth_getBlockByNumber").every(call => JSON.stringify(call.params) === '["0x100",false]')).toBe(true);
    expect(calls.some(call => call.params.includes("safe") || call.params.includes("finalized"))).toBe(false);
    expect(Object.isFrozen(result.assurance)).toBe(true);
  });
  it.each(["eth_chainId", "eth_getTransactionReceipt", "eth_getBlockByNumber", "eth_blockNumber"])("refuses if a selected third operator fails %s", async method => {
    const rpcUrls = [...URLS, "https://rpc-c.example.test/key"];
    const { fetch, calls } = fetchServing(await honest());
    const failure: typeof globalThis.fetch = async (url, init) => {
      const request = JSON.parse(String(init?.body));
      if (String(url) === rpcUrls[2] && request.method === method) return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "synthetic" } }));
      return fetch(url, init);
    };
    refused(await verifySettlement({ ...TYPED, rpcUrls, allowedRpcHosts: rpcUrls.map(url => new URL(url).host), fetch: failure }), "rpc_error");
    expect(calls.some(call => call.method === method)).toBe(true);
  });
  it("uses the lowest head independent of operator order", async () => {
    for (const rpcUrls of [URLS, [...URLS].reverse()]) {
      const { result } = await run(await honest(), { rpcUrls }, (call, result) => call.method === "eth_blockNumber" ? quantity(call.url === URLS[0] ? 290 : 268) : result);
      expect(result.ok && result.confirmations).toBe(12);
      expect(result.ok && result.headFrom).toBe(HOSTS[1]);
    }
  });
  it.each([[11, 11, "insufficient_confirmations"], [12, 43, "rpc_head_divergence"], [-1, 12, "insufficient_confirmations"]])("refuses heads with depths %s/%s", async (first, second, reason) => {
    const { result } = await run(await honest(), {}, (call, value) => call.method === "eth_blockNumber" ? quantity(256 + (call.url === URLS[0] ? Number(first) : Number(second))) : value);
    refused(result, String(reason));
  });
  it("accepts exactly 30 blocks of head divergence and exactly the configured depth", async () => {
    const { result } = await run(await honest(), { minConfirmations: 13 }, (call, value) => call.method === "eth_blockNumber" ? quantity(call.url === URLS[0] ? 269 : 299) : value);
    expect(result.ok && result.confirmations).toBe(13);
    refused((await run(await honest(), { minConfirmations: 13 })).result, "insufficient_confirmations");
  });
  it.each([0, 1, 11, 12.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("refuses confirmation configuration %s before reading", async minConfirmations => {
    const { result, calls } = await run(await honest(), { minConfirmations });
    refused(result, "verifier_misconfigured"); expect(calls).toHaveLength(0);
  });
  it("uses the actual default fetch boundary when no injection is supplied", async () => {
    const served = fetchServing(await honest());
    vi.stubGlobal("fetch", served.fetch);
    try { expect((await verifySettlement(TYPED)).ok).toBe(true); expect(served.calls).toHaveLength(8); }
    finally { vi.unstubAllGlobals(); }
  });
});

describe("operator policy and aliases", () => {
  it("requires explicit unpinned opt-in and retains that status", async () => {
    refused((await run(await honest(), { allowedRpcHosts: [] })).result, "rpc_host_not_allowlisted");
    const { result } = await run(await honest(), { allowedRpcHosts: [HOSTS[0]], allowUnpinnedRpc: true });
    expect(result.ok && result.unpinned).toBe(true);
    expect(result.ok && result.unpinnedHosts).toEqual([HOSTS[1]]);
  });
  it.each([
    ["https://same.example.test/a", "https://same.example.test:443/b"],
    ["https://same.example.test/a", "https://same.example.test:8443/b"],
    ["https://same.example.test", "https://same.example.test."],
    ["https://localhost", "https://127.0.0.1:8443"],
    ["https://a.localhost", "https://[::1]"], ["https://[::]", "https://0.0.0.0"],
    ["https://[::ffff:127.0.0.1]", "https://127.0.0.2"], ["https://[::ffff:0:0]", "https://localhost"],
  ])("collapses aliases %s and %s before any read", async (a, b) => {
    const { result, calls } = await run(await honest(), { rpcUrls: [a, b], allowedRpcHosts: [], allowUnpinnedRpc: true });
    refused(result, "insufficient_rpc_quorum"); expect(calls).toHaveLength(0);
  });
  it("queries a duplicate hostname once while retaining the other operator", async () => {
    const { result, calls } = await run(await honest(), { rpcUrls: [URLS[0], `${URLS[0]}-other`, URLS[1]] });
    expect(result.ok && result.headOperators).toBe(2); expect(calls).toHaveLength(8);
  });
  it.each([[[], "no_rpc_endpoints"], [["secret-no-scheme"], "bad_rpc_url"], [["http://rpc-a.example.test"], "rpc_not_https"], [["ftp://rpc-a.example.test"], "rpc_not_https"]])("refuses invalid selected endpoints", async (rpcUrls, reason) => {
    const { result, calls } = await run(await honest(), { rpcUrls: rpcUrls as string[] });
    refused(result, String(reason)); expect(calls).toHaveLength(0); expect(JSON.stringify(result)).not.toContain("secret");
  });
  it("never returns path credentials or raw fetch exceptions", async () => {
    const rpcUrls = ["https://user:SECRET@rpc-a.example.test/v2/SECRET?api_key=SECRET", URLS[1]];
    const failure: typeof globalThis.fetch = async () => { throw new Error(rpcUrls[0]); };
    const result = await verifySettlement({ ...TYPED, rpcUrls, fetch: failure });
    expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toMatch(/SECRET|https:|user:/);
    const { result: success } = await run(await honest(), { rpcUrls });
    expect(success.ok).toBe(true); expect(JSON.stringify(success)).not.toMatch(/SECRET|https:|user:/);
  });
});

describe("receipt identity, agreement and block binding", () => {
  it("preserves nested/null receipt fields during canonical agreement", async () => {
    const document = { ...await honest(), extra: { b: [1, null, { nested: true }], a: null } };
    const ordered = Object.fromEntries(Object.entries(document).reverse());
    expect((await run(document, {}, (call, value) => call.method === "eth_getTransactionReceipt" && call.url === URLS[1] ? ordered : value)).result.ok).toBe(true);
    for (const changed of [{ ...document, extra: { b: [1, null, { nested: false }], a: null } }, { ...document, extra: { b: [1, null, { nested: true }] } }]) {
      refused((await run(document, {}, (call, value) => call.method === "eth_getTransactionReceipt" && call.url === URLS[1] ? changed : value)).result, "rpc_divergence");
    }
  });
  it("refuses mixed missing receipts and distinguishes unanimous missing", async () => {
    refused((await run(null)).result, "tx_not_found");
    refused((await run(await honest(), {}, (call, value) => call.method === "eth_getTransactionReceipt" && call.url === URLS[1] ? null : value)).result, "rpc_divergence");
  });
  it.each([
    ["transactionHash", undefined, "receipt_not_for_this_tx"], ["transactionHash", `0x${"cd".repeat(32)}`, "receipt_not_for_this_tx"],
    ["transactionHash", [TX], "receipt_not_for_this_tx"], ["status", "0x0", "tx_reverted"], ["status", true, "tx_reverted"],
    ["logs", {}, "receipt_logs_malformed"], ["blockNumber", "0x", "receipt_not_mined"], ["blockNumber", 256, "receipt_not_mined"],
    ["blockNumber", "0x20000000000000", "receipt_not_mined"], ["blockHash", undefined, "block_hash_unreadable"],
  ])("refuses receipt field %s=%j", async (key, value, reason) => {
    const document: any = await honest(); document[String(key)] = value;
    refused((await run(document)).result, String(reason));
  });
  it.each([[], false, "wrong"])("refuses non-document receipt %j", async document => refused((await run(document)).result, "receipt_not_for_this_tx"));
  it.each([true, ["0x2105"], "0x1", "0x02105", "0x", null])("refuses wrong chain shape/value %j at a peer", async chain => {
    refused((await run(await honest(), {}, (call, value) => call.method === "eth_chainId" && call.url === URLS[1] ? chain : value)).result, "wrong_chain");
  });
  it.each([null, { hash: BLOCK_HASH }, { hash: TX, number: "0x100" }, { hash: BLOCK_HASH, number: "0x101" }, { hash: BLOCK_HASH, number: true }])("requires every peer's exact block %j", async block => {
    refused((await run(await honest(), {}, (call, value) => call.method === "eth_getBlockByNumber" && call.url === URLS[1] ? block : value)).result, block === null ? "block_not_found" : "block_hash_mismatch");
  });
  it.each([true, [], "0x", "0x010c", "0x20000000000000", null])("refuses unreadable peer head %j", async head => {
    refused((await run(await honest(), {}, (call, value) => call.method === "eth_blockNumber" && call.url === URLS[1] ? head : value)).result, "rpc_head_unreadable");
  });
});

describe("payer-scoped nonce and subsequent paired Transfer", () => {
  it.each([
    ["removed", true, "log_removed"], ["removed", "true", "log_malformed"],
    ["transactionHash", TX.replace("ab", "cd"), "log_not_for_this_tx"], ["transactionHash", undefined, "log_not_for_this_tx"],
    ["blockHash", TX, "log_not_in_this_block"], ["blockNumber", "0x101", "log_not_in_this_block"],
    ["topics", "bad", "log_topics_malformed"], ["topics", [], "log_topics_malformed"], ["topics", [TX, TX, true], "log_topics_malformed"],
    ["data", "0x1", "log_data_malformed"], ["data", 1, "log_data_malformed"],
    ["logIndex", undefined, "log_index_unreadable"], ["logIndex", 1, "log_index_unreadable"], ["logIndex", "0x100000000", "log_index_unreadable"],
  ])("refuses canonical token log field %s=%j", async (key, value, reason) => {
    const document: any = await honest(); document.logs[0][String(key)] = value;
    refused((await run(document)).result, String(reason));
  });
  it("rejects a malformed log even for an unrelated token", async () => {
    const document: any = await honest(); document.logs.push(null);
    refused((await run(document)).result, "log_malformed");
  });
  it("pairs by explicit log index rather than array order, with one payer's nonce only", async () => {
    const nonce = await settlementNonce(GRANT_HASH);
    const document = receipt([transfer(), auth(nonce), auth(nonce, 2, OTHER), transfer("1", 3, OTHER, OTHER)]);
    expect((await run(document)).result.ok).toBe(true);
  });
  it("refuses duplicate log indices", async () => {
    const document = await honest(); document.logs[1].logIndex = "0x0";
    refused((await run(document)).result, "log_index_duplicate");
  });
  it.each([
    ["nonce_not_spent_by_this_tx", async () => receipt([auth(`0x${"ff".repeat(32)}`), transfer()])],
    ["authorizer_mismatch", async () => receipt([auth(await settlementNonce(GRANT_HASH), 0, OTHER), transfer()])],
    ["authorization_ambiguous", async () => receipt([auth(await settlementNonce(GRANT_HASH)), transfer(), auth(await settlementNonce(GRANT_HASH), 2)])],
    ["no_usdc_transfer", async () => receipt([auth(await settlementNonce(GRANT_HASH))])],
    ["paired_transfer_missing", async () => receipt([transfer("50000", 0), auth(await settlementNonce(GRANT_HASH), 1)])],
    ["transfer_payer_mismatch", async () => receipt([auth(await settlementNonce(GRANT_HASH)), transfer("50000", 1, OTHER)])],
    ["transfer_recipient_mismatch", async () => receipt([auth(await settlementNonce(GRANT_HASH)), transfer("50000", 1, PAYER, OTHER), transfer("50000", 2)])],
    ["transfer_ambiguous", async () => receipt([auth(await settlementNonce(GRANT_HASH)), transfer(), transfer("1", 2)])],
    ["exact_value", async () => receipt([auth(await settlementNonce(GRANT_HASH)), transfer("50001")])],
  ] as const)("refuses %s", async (reason, document) => refused((await run(await document())).result, reason));
  it("requires canonical address-topic padding and a full transfer amount word", async () => {
    let document = await honest(); document.logs[0].topics[1] = `0x1${topic(PAYER).slice(3)}`;
    refused((await run(document)).result, "authorizer_mismatch");
    for (const data of ["0x", "0x01", `${word(1)}00`]) {
      document = await honest(); document.logs[1].data = data;
      refused((await run(document)).result, "transfer_value_unreadable");
    }
  });
  it("ignores unrelated-token events without letting them supply payment evidence", async () => {
    const document = await honest(); document.logs[0].address = OTHER;
    refused((await run(document)).result, "nonce_not_spent_by_this_tx");
  });
});

describe("historical complete grant terms", () => {
  it.each(["50000", "5000000"])("admits historical receipt at band boundary %s", async amount => {
    const data = await grantReceipt(amount);
    const { result } = await run(data.receipt, { grant: data.grant, grantHash: undefined, payer: undefined, payee: undefined, amount: undefined });
    expect(result.ok && result.value).toBe(amount);
    expect(result.ok && result.terms).toEqual({ source: "grant", expiresAt: data.grant.expires_at, band: { min: "50000", max: "5000000" } });
  });
  it.each(["49999", "5000001"])("refuses receipt amount outside grant band %s", async amount => {
    const data = await grantReceipt(amount);
    refused((await run(data.receipt, { grant: data.grant, grantHash: undefined, payer: undefined, payee: undefined, amount: undefined })).result, "amount_outside_grant_band");
  });
  it("binds typed overrides to the grant and then to the exact receipt amount", async () => {
    const data = await grantReceipt("100000"), gh = await hashArtifact(data.grant);
    const base = { grant: data.grant, grantHash: gh, payer: PAYER, payee: PAYEE, amount: "100000" };
    expect((await run(data.receipt, base)).result.ok).toBe(true);
    for (const mutation of [{ payer: OTHER }, { payee: OTHER }, { grantHash: GRANT_HASH }, { amount: "1" }]) refused((await run(data.receipt, { ...base, ...mutation })).result, "grant_terms_mismatch");
    refused((await run(data.receipt, { ...base, amount: "50000" })).result, "exact_value");
    expect((await run(data.receipt, { ...base, amount: "0100000" })).result.ok).toBe(true);
  });
  it("snapshots terms, endpoints and policy before asynchronous work", async () => {
    const data = await grantReceipt(), served = fetchServing(data.receipt);
    const rpcUrls = [...URLS], allowedRpcHosts = [...HOSTS];
    const input = { tx: TX, grant: data.grant, rpcUrls, allowedRpcHosts, fetch: served.fetch };
    const pending = verifySettlement(input);
    data.grant.price_payee_account = `eip155:8453:${OTHER}`; data.grant.price_min_amount = "1";
    rpcUrls[0] = "https://attacker.invalid/SECRET"; allowedRpcHosts.length = 0;
    const result = await pending;
    expect(result.ok && result.payee).toBe(PAYEE); expect(result.ok && result.value).toBe("50000");
    expect(result.ok && result.rpcHosts).toEqual(HOSTS);
  });
  it("preserves grant null omission while receipt null remains part of agreement", async () => {
    const data = await grantReceipt();
    expect((await run(data.receipt, { grant: { ...data.grant, extra: null }, grantHash: undefined, payer: undefined, payee: undefined, amount: undefined })).result.ok).toBe(true);
  });
  it.each([
    { schema: "other" }, { price_chain: "eip155:84532" }, { price_asset: `eip155:8453/erc20:${OTHER}` },
    { price_payee_account: `eip155:8453:${PAYEE.toUpperCase()}` }, { price_min_amount: "1.5" }, { price_max_amount: "1" }, { extra: "unknown" },
  ])("refuses malformed or non-Base grant terms %j before reads", async mutation => {
    const served = fetchServing(null);
    expect((await verifySettlement({ tx: TX, grant: { ...grant(), ...mutation }, rpcUrls: URLS, allowedRpcHosts: HOSTS, fetch: served.fetch })).ok).toBe(false);
    expect(served.calls).toHaveLength(0);
  });
  it("refuses arbitrary grant expiry metadata without reflecting it", async () => {
    const g = { ...grant(), expires_at: "https://user:SYNTHETIC_REVIEW_SECRET@host.example/key" };
    const document = await honest(await hashArtifact(g));
    const served = fetchServing(document);
    const result = await verifySettlement({ tx: TX, grant: g, rpcUrls: URLS, allowedRpcHosts: HOSTS, fetch: served.fetch });
    refused(result, "grant_not_a_grant_envelope");
    expect(served.calls).toHaveLength(0);
    expect(JSON.stringify(result)).not.toMatch(/SYNTHETIC_REVIEW_SECRET|https:/);
  });
  it("does not invoke input, grant or endpoint accessors", async () => {
    const getter = vi.fn();
    const evilGrant = Object.defineProperty(grant(), "price_payee_account", { enumerable: true, get: getter });
    expect((await verifySettlement({ ...TYPED, grant: evilGrant })).ok).toBe(false);
    const urls = [...URLS]; Object.defineProperty(urls, "0", { enumerable: true, get: getter });
    expect((await verifySettlement({ ...TYPED, rpcUrls: urls })).ok).toBe(false);
    expect((await verifySettlement({ ...TYPED, get payer() { getter(); return PAYER; } })).ok).toBe(false);
    expect(getter).not.toHaveBeenCalled();
  });
});
