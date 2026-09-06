
import {
  fetchVerifiedProvider, buildHire, buildReceivePaymentAuthorization,
  submitHire, recoverResult, x402SessionAccountCaip10,
} from "@voidly/session";

const MANIFEST_URL = "https://intelligence.voidly.ai:8443/.well-known/voidly-session-provider.json";
const PROVIDER_DID = "did:voidly:6rGTFa5apSnKNF14bGXZfu";

const { did, signingPublicKeyBase64, sign, signReceive, payer } = await loadAgent();

const found = await fetchVerifiedProvider({ manifestUrl: MANIFEST_URL, expectedProviderDid: PROVIDER_DID, fetchImpl: fetch });
if (!found.ok) throw new Error(found.reason);

const offering = found.provider.manifest.services.find((s) => s.ref === "voidly.observatory.query/v1");
const hire = await buildHire({
  hirer: { did, signingPublicKeyBase64, sign },
  provider: found.provider,
  service: { ref: offering.ref },
  task: { brief: "Is twitter.com blocked in Iran right now? Cite evidence." },
  price: {
    chain: offering.price.chain,
    asset: offering.price.asset,
    payerAccount: x402SessionAccountCaip10(offering.price.chain, payer),
    payeeAccount: offering.price.payee_account,
    minAmount: offering.price.min_amount,
    maxAmount: offering.price.max_amount,
  },
  ttl: { offerMs: 30 * 60_000, grantMs: 10 * 60_000 },
  nowMs: Date.now(),
});
if (!hire.ok) throw new Error(hire.reason);

const paid = await buildReceivePaymentAuthorization({
  grant: hire.wire.grant, grantHash: hire.keep.grant_hash, nowMs: Date.now(), sign: signReceive,
});
if (!paid.ok) throw new Error(paid.reason);

const out = await submitHire({
  url: found.provider.manifest.accept_url, wire: hire.wire, grantHash: hire.keep.grant_hash,
  authorization: paid.authorization, sign, nowMs: Date.now(), fetchImpl: fetch,
});
if (out.kind !== "accepted") throw new Error(out.kind);

let read;
do {
  read = await recoverResult({
    endpoint: { baseUrl: found.provider.manifest.worker_base_url },
    wire: hire.wire, grantHash: hire.keep.grant_hash,
    sessionKey: hire.keep.sessionKey, sign, nowMs: Date.now(),
  });
} while (read.kind === "no_result" && await sleep(2000));
console.log(read.kind === "opened" ? read.result : read);

function sleep(ms) { return new Promise((r) => setTimeout(() => r(true), ms)); }
