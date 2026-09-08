import { hashArtifact, settlementNonce, x402SessionAssetCaip19 } from "../src/index";
export const TX = `0x${"ab".repeat(32)}`;
export const BLOCK_HASH = `0x${"77".repeat(32)}`;
export const PAYER = `0x${"11".repeat(20)}`;
export const PAYEE = `0x${"22".repeat(20)}`;
export const OTHER = `0x${"33".repeat(20)}`;
export const TOKEN = x402SessionAssetCaip19("eip155:8453")!.split("erc20:")[1];
export const GRANT_HASH = "aa".repeat(32);
export const URLS = ["https://rpc-a.example.test/v2/synthetic", "https://rpc-b.example.test/v2/synthetic"];
export const HOSTS = URLS.map(url => new URL(url).host);
export const TYPED = { tx: TX, grantHash: GRANT_HASH, payer: PAYER, payee: PAYEE, amount: "50000", rpcUrls: URLS, allowedRpcHosts: HOSTS };
export const AUTH_TOPIC = "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const identity = { transactionHash: TX, blockHash: BLOCK_HASH, blockNumber: "0x100" };
export const quantity = (value: number | bigint) => `0x${value.toString(16)}`;
export const topic = (address: string) => `0x${address.slice(2).padStart(64, "0")}`;
export const word = (value: string | number) => `0x${BigInt(value).toString(16).padStart(64, "0")}`;
export const auth = (nonce: string, index = 0, payer = PAYER) => ({ ...identity, address: TOKEN, topics: [AUTH_TOPIC, topic(payer), nonce], data: "0x", logIndex: quantity(index) });
export const transfer = (value: string | number = "50000", index = 1, payer = PAYER, payee = PAYEE) => ({ ...identity, address: TOKEN, topics: [TRANSFER_TOPIC, topic(payer), topic(payee)], data: word(value), logIndex: quantity(index) });
export type FixtureLog = ReturnType<typeof auth>;
export const receipt = (logs: FixtureLog[]) => ({ ...identity, status: "0x1", logs });
export async function honest(grantHash = GRANT_HASH, value = "50000") { return receipt([auth(await settlementNonce(grantHash)), transfer(value)]); }
export const grant = () => ({
  schema: "voidly-task-grant/v1", hirer_did: "did:voidly:synthetic-hirer", provider_did: "did:voidly:synthetic-provider",
  provider_signing_pubkey_base64: "ERERERERERERERERERERERERERERERERERERERERERE=", provider_enc_pubkey_base64: "IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI=",
  offer_hash: "01".repeat(32), capsule_hash: "02".repeat(32), brief_commitment: "03".repeat(32), price_chain: "eip155:8453",
  price_asset: `eip155:8453/erc20:${TOKEN}`, price_payer_account: `eip155:8453:${PAYER}`, price_payee_account: `eip155:8453:${PAYEE}`,
  price_min_amount: "50000", price_max_amount: "5000000", nonce: "c3ludGhldGljLW5vbmNlLW9ubHk=",
  issued_at: "2025-01-01T00:00:00.000Z", expires_at: "2025-01-01T00:10:00.000Z",
});
export async function grantReceipt(value = "50000") { const g = grant(); return { grant: g, receipt: await honest(await hashArtifact(g), value) }; }
export type RpcCall = { url: string; method: string; params: unknown[]; id: number };
export function fetchServing(document: unknown, modify?: (call: RpcCall, result: unknown) => unknown) {
  const calls: RpcCall[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.jsonrpc !== "2.0" || typeof body.id !== "number" || init?.method !== "POST" || init.redirect !== "error") throw new Error("unexpected request shape");
    const call: RpcCall = { url: String(url), method: body.method, params: body.params, id: body.id };
    calls.push(call);
    const defaults: Record<string, unknown> = {
      eth_chainId: "0x2105", eth_getTransactionReceipt: document,
      eth_getBlockByNumber: { hash: BLOCK_HASH, number: "0x100" }, eth_blockNumber: "0x10c",
    };
    if (!(call.method in defaults)) throw new Error("non-read method requested");
    const result = modify ? modify(call, defaults[call.method]) : defaults[call.method];
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { headers: { "content-type": "application/json" } });
  };
  return { fetch, calls };
}
