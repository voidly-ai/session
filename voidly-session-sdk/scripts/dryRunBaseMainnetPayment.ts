
import {
  buildHire,
  buildTransferAuthorizationTypedData,
  buildTransferWithAuthorizationCalldata,
  createReadOnlyEvmRpc,
  decodeRevertReason,
  deriveDidFromSigningKey,
  envelopeHash,
  EVM_USDC_EIP712_DOMAINS,
  FORBIDDEN_RPC_METHODS,
  privateHire,
  revertDataFromRpcError,
  settlementNonce,
  TRANSFER_WITH_AUTHORIZATION_SELECTOR,
  TRANSFER_WITH_AUTHORIZATION_TYPEHASH,
  webCryptoEntropy,
  x402SessionAccountCaip10,
  x402SessionAssetCaip19,
  verifyProvider,
  x402SessionEvidence,
  X402_SESSION_USDC_BY_CHAIN,
} from "../src/index";
import type { ReadOnlyEvmRpc, SignedTransferAuthorization, VerifiedProvider } from "../src/index";
import { buildManifest } from "../tests/_manifestFixture";

const CHAIN = "eip155:8453";

const PAYER = "0x5cad296e06a976886a5d5bef831520c3d5965af0";
const PAYEE = "0xb0b3fca940e04f99367f08e665e1c2cb4ebd4912";

const MIN_CONFIRMATIONS = 12;
const AUTHORIZATION_WINDOW_SECONDS = 30 * 60;

const SERVICE_REF = "voidly.observatory.query/v1";
const BRIEF = JSON.stringify({ query: "domain", country: "IR", domain: "twitter.com" });

const SELECTORS = {
  "name()": "0x06fdde03",
  "version()": "0x54fd4d50",
  "DOMAIN_SEPARATOR()": "0x3644e515",
  "TRANSFER_WITH_AUTHORIZATION_TYPEHASH()": "0xa0cc6a68",
  "decimals()": "0x313ce567",
} as const;

const out = (line = "") => process.stdout.write(`${line}\n`);
const rule = (title: string) => {
  out();
  out(`── ${title} ${"─".repeat(Math.max(0, 74 - title.length))}`);
  out();
};

let problems = 0;
let unknowns = 0;

function check(ok: boolean, label: string, detail = ""): boolean {
  if (!ok) problems++;
  out(`  ${ok ? "OK   " : "WRONG"}  ${label}${detail ? `  ${detail}` : ""}`);
  return ok;
}

function checkKnown(
  value: unknown,
  ok: boolean,
  label: string,
  detail = "",
): void {
  if (value === null || value === undefined) {
    unknowns++;
    out(`  ?      ${label}  — NOT CHECKED: the read did not come back. Says nothing either way.`);
    return;
  }
  check(ok, label, detail);
}

function decodeAbiString(hex: string): string | null {
  if (typeof hex !== "string" || !hex.startsWith("0x")) return null;
  const b = hex.slice(2);
  if (b.length < 128) return null;
  const offset = Number.parseInt(b.slice(0, 64), 16) * 2;
  const length = Number.parseInt(b.slice(offset, offset + 64), 16) * 2;
  const body = b.slice(offset + 64, offset + 64 + length);
  if (body.length !== length) return null;
  const bytes = new Uint8Array(length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
  return new TextDecoder().decode(bytes);
}

function atomicToUsdc(atomic: bigint): string {
  const whole = atomic / BigInt(1_000_000);
  const frac = (atomic % BigInt(1_000_000)).toString().padStart(6, "0");
  return `${whole}.${frac}`;
}

function weiToEth(wei: bigint): string {
  const whole = wei / BigInt(10) ** BigInt(18);
  const frac = (wei % BigInt(10) ** BigInt(18)).toString().padStart(18, "0");
  return `${whole}.${frac}`;
}

function hexToBigInt(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]*$/.test(value) || value === "0x") return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

async function seededBytes(seed: string, label: string, length: number): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const buf = new Uint8Array(length);
  let filled = 0;
  for (let counter = 0; filled < length; counter++) {
    const block = new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(`${seed}:${label}:${counter}`)),
    );
    const take = Math.min(block.length, length - filled);
    buf.set(block.subarray(0, take), filled);
    filled += take;
  }
  return buf;
}

async function seededHex(seed: string, label: string): Promise<string> {
  return Array.from(await seededBytes(seed, label, 32))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function seededEntropy(seed: string) {
  return {
    offerNonce: `dryrun-offer-${await seededHex(seed, "offer-nonce")}`,
    grantNonce: `dryrun-grant-${await seededHex(seed, "grant-nonce")}`,
    sessionKey: await seededBytes(seed, "session-key", 32),
    ephemeralSecretKey: await seededBytes(seed, "ephemeral-secret", 32),
    briefSalt: await seededBytes(seed, "brief-salt", 32),
    bodyNonce: await seededBytes(seed, "body-nonce", 24),
    wrapNonce: await seededBytes(seed, "wrap-nonce", 24),
  };
}

async function readCall(rpc: ReadOnlyEvmRpc, to: string, data: string): Promise<string | null> {
  const res = await rpc.request("eth_call", [{ to, data }, "latest"]);
  if (!res.ok) {
    out(`         eth_call ${data.slice(0, 10)} FAILED — ${res.reason}: ${res.detail}`);
    return null;
  }
  return typeof res.result === "string" ? res.result : null;
}

export async function dryRun(): Promise<number> {
  const rpcUrl = process.env.VOIDLY_DRYRUN_RPC_URL ?? "https://mainnet.base.org";
  const amount = process.env.VOIDLY_DRYRUN_AMOUNT ?? "1000000";
  const suppliedSignature = process.env.VOIDLY_DRYRUN_SIGNATURE ?? null;
  const seed = process.env.VOIDLY_DRYRUN_SEED ?? null;
  const pinnedNowMs = process.env.VOIDLY_DRYRUN_NOW_MS
    ? Number(process.env.VOIDLY_DRYRUN_NOW_MS)
    : null;

  out();
  out("╔══════════════════════════════════════════════════════════════════════════╗");
  out("║  VOIDLY SESSION RAIL — BASE MAINNET PAYMENT DRY RUN                       ║");
  out("║  Builds a real grant, derives the real nonce, simulates the real call.    ║");
  out("║  IT DOES NOT BROADCAST. It cannot: see section 7.                         ║");
  out("╚══════════════════════════════════════════════════════════════════════════╝");
  out();
  out(`  rpc         ${rpcUrl}`);
  out(`  payer       ${PAYER}`);
  out(`  payee       ${PAYEE}   (also the relayer — it holds the gas)`);
  out(`  amount      ${amount} atomic = ${atomicToUsdc(BigInt(amount))} USDC`);
  out(`  signature   ${suppliedSignature ? "SUPPLIED via VOIDLY_DRYRUN_SIGNATURE" : "NOT SUPPLIED — a placeholder is used, see section 6"}`);
  out(`  grant       ${seed ? "SEEDED (reproducible)" : "fresh entropy (changes every run)"}`);
  if (seed !== null) {
    out();
    out("  ⚠ SEEDED RUN. The session key is a function of VOIDLY_DRYRUN_SEED, so");
    out("    anyone who learns the seed can open this hire's brief and result. That");
    out("    is fine for a rehearsal whose grant is never transmitted, and is NOT");
    out("    fine for a real hire — a real one omits the seed and gets");
    out("    webCryptoEntropy().");
  }
  if (seed !== null && pinnedNowMs === null) {
    out();
    out("  ⚠ A SEED WITHOUT VOIDLY_DRYRUN_NOW_MS IS NOT REPRODUCIBLE. The grant's");
    out("    issued_at and expires_at come from the clock and are inside the hash,");
    out("    so the nonce will still move between runs. The pair to re-run with is");
    out("    printed in the summary.");
  }

  const rpc = createReadOnlyEvmRpc({
    url: rpcUrl,
    fetchImpl: globalThis.fetch as never,
  });

  rule("1. THE CHAIN, AND EVERY PINNED DOMAIN FIELD, READ OFF THE DEPLOYMENT");

  const token = X402_SESSION_USDC_BY_CHAIN.get(CHAIN);
  const domain = EVM_USDC_EIP712_DOMAINS.get(CHAIN);
  if (!token || !domain) {
    out("  the frozen USDC table has no entry for eip155:8453. Nothing to do.");
    return 1;
  }

  const chainIdRes = await rpc.request("eth_chainId", []);
  const observedChainId = chainIdRes.ok ? hexToBigInt(chainIdRes.result) : null;
  out(`  eth_chainId                             -> ${chainIdRes.ok ? String(chainIdRes.result) : `FAILED ${chainIdRes.reason}`}`);
  checkKnown(
    observedChainId,
    observedChainId === BigInt(8453),
    "chain id is 8453 (Base mainnet)",
    `saw ${observedChainId}`,
  );

  const rawName = await readCall(rpc, token, SELECTORS["name()"]);
  const rawVersion = await readCall(rpc, token, SELECTORS["version()"]);
  const rawSeparator = await readCall(rpc, token, SELECTORS["DOMAIN_SEPARATOR()"]);
  const rawTypehash = await readCall(rpc, token, SELECTORS["TRANSFER_WITH_AUTHORIZATION_TYPEHASH()"]);
  const rawDecimals = await readCall(rpc, token, SELECTORS["decimals()"]);

  out();
  out(`  name()                                  -> ${rawName ?? "(unavailable)"}`);
  out(`  version()                               -> ${rawVersion ?? "(unavailable)"}`);
  out(`  DOMAIN_SEPARATOR()                      -> ${rawSeparator ?? "(unavailable)"}`);
  out(`  TRANSFER_WITH_AUTHORIZATION_TYPEHASH()  -> ${rawTypehash ?? "(unavailable)"}`);
  out(`  decimals()                              -> ${rawDecimals ?? "(unavailable)"}`);
  out();

  checkKnown(
    rawName,
    decodeAbiString(rawName ?? "") === domain.name,
    `name() is ${JSON.stringify(domain.name)}`,
    `saw ${JSON.stringify(decodeAbiString(rawName ?? ""))}`,
  );
  checkKnown(
    rawVersion,
    decodeAbiString(rawVersion ?? "") === domain.version,
    `version() is ${JSON.stringify(domain.version)}`,
    `saw ${JSON.stringify(decodeAbiString(rawVersion ?? ""))}`,
  );
  checkKnown(
    rawSeparator,
    rawSeparator === domain.domainSeparator,
    "DOMAIN_SEPARATOR() equals the SDK's pinned value",
    rawSeparator === domain.domainSeparator ? "" : `pinned ${domain.domainSeparator}`,
  );
  checkKnown(
    rawTypehash,
    rawTypehash === TRANSFER_WITH_AUTHORIZATION_TYPEHASH,
    "TRANSFER_WITH_AUTHORIZATION_TYPEHASH() equals the SDK's pinned value",
    rawTypehash === TRANSFER_WITH_AUTHORIZATION_TYPEHASH ? "" : `pinned ${TRANSFER_WITH_AUTHORIZATION_TYPEHASH}`,
  );
  checkKnown(rawDecimals, hexToBigInt(rawDecimals ?? "") === BigInt(6), "decimals() is 6");
  check(
    domain.verifyingContract === token,
    "the SDK's domain table and the adapter's token table name the same contract",
    token,
  );

  rule("2. THE BALANCES, BEFORE");

  const balanceOf = (a: string) => `0x70a08231${a.slice(2).toLowerCase().padStart(64, "0")}`;
  const payerUsdc = hexToBigInt(await readCall(rpc, token, balanceOf(PAYER)));
  const payeeUsdc = hexToBigInt(await readCall(rpc, token, balanceOf(PAYEE)));
  const payerEthRes = await rpc.request("eth_getBalance", [PAYER, "latest"]);
  const payeeEthRes = await rpc.request("eth_getBalance", [PAYEE, "latest"]);
  const payerEth = payerEthRes.ok ? hexToBigInt(payerEthRes.result) : null;
  const payeeEth = payeeEthRes.ok ? hexToBigInt(payeeEthRes.result) : null;

  out(`  payer  ${PAYER}`);
  out(`         USDC ${payerUsdc === null ? "(unavailable)" : atomicToUsdc(payerUsdc)}    ETH ${payerEth === null ? "(unavailable)" : weiToEth(payerEth)}`);
  out(`  payee  ${PAYEE}`);
  out(`         USDC ${payeeUsdc === null ? "(unavailable)" : atomicToUsdc(payeeUsdc)}    ETH ${payeeEth === null ? "(unavailable)" : weiToEth(payeeEth)}`);
  out();
  checkKnown(
    payerUsdc,
    payerUsdc !== null && payerUsdc >= BigInt(amount),
    "the payer holds at least the amount",
    payerUsdc === null ? "" : `${atomicToUsdc(payerUsdc)} USDC`,
  );
  checkKnown(
    payeeEth,
    payeeEth !== null && payeeEth > BigInt(0),
    "the payee holds ETH, so it can relay",
    payeeEth === null ? "" : `${weiToEth(payeeEth)} ETH`,
  );

  rule("3. THE REAL GRANT");

  const asset = x402SessionAssetCaip19(CHAIN);
  const payerAccount = x402SessionAccountCaip10(CHAIN, PAYER);
  const payeeAccount = x402SessionAccountCaip10(CHAIN, PAYEE);
  if (!asset || !payerAccount || !payeeAccount) {
    out("  could not derive the CAIP strings. Nothing to do.");
    return 1;
  }
  out(`  price_chain          ${CHAIN}`);
  out(`  price_asset          ${asset}`);
  out(`  price_payer_account  ${payerAccount}`);
  out(`  price_payee_account  ${payeeAccount}`);
  out(`  price_min_amount     ${amount}`);
  out(`  price_max_amount     ${amount}`);

  const nacl = (await import("tweetnacl")).default;
  const util = await import("tweetnacl-util");

  const identitySeed = seed === null ? null : await seededBytes(seed, "identities", 96);
  const hirerKp = identitySeed
    ? nacl.sign.keyPair.fromSeed(identitySeed.subarray(0, 32))
    : nacl.sign.keyPair();
  const providerKp = identitySeed
    ? nacl.sign.keyPair.fromSeed(identitySeed.subarray(32, 64))
    : nacl.sign.keyPair();
  const providerBox = identitySeed
    ? nacl.box.keyPair.fromSecretKey(identitySeed.subarray(64, 96))
    : nacl.box.keyPair();

  const nowMs =
    pinnedNowMs !== null && Number.isFinite(pinnedNowMs) && pinnedNowMs > 0
      ? Math.floor(pinnedNowMs)
      : Date.now();
  const GRANT_TTL_MS = 30 * 60_000;
  if (pinnedNowMs !== null && Date.now() - nowMs > GRANT_TTL_MS) {
    out();
    out(`  ⚠ VOIDLY_DRYRUN_NOW_MS is more than the ${GRANT_TTL_MS / 60_000}-minute grant TTL in the past.`);
    out("    The grant this builds is already expired and a redemption would refuse it.");
    out("    Re-run the first leg to get a fresh pair.");
  }

  const providerDid = deriveDidFromSigningKey(providerKp.publicKey);
  const providerEncEntry = {
    publicKeyBase64: util.encodeBase64(providerBox.publicKey),
    secretKey: providerBox.secretKey,
    retainUntilMs: null,
  };
  const providerManifest = buildManifest(
    {
      did: providerDid,
      signingPublicKey: providerKp.publicKey,
      sign: (bytes: Uint8Array) => nacl.sign.detached(bytes, providerKp.secretKey),
      currentEncryption: providerEncEntry,
      encryptionKeyring: [providerEncEntry],
    },
    {
      acceptUrl: "https://provider.invalid/session/accept",
      workerBaseUrl: "https://api.voidly.ai",
      attestorPublicKey: providerKp.publicKey,
      services: [
        {
          ref: SERVICE_REF,
          description: "one observatory query",
          chain: CHAIN,
          asset,
          payeeAccount,
          minAmount: amount,
          maxAmount: amount,
        },
      ],
      minGrantTtlMs: 60_000,
      maxGrantTtlMs: 6 * 60 * 60_000,
      acceptanceTtlMs: 5 * 60_000,
    },
  );
  const providerVerdict = verifyProvider(
    JSON.parse(JSON.stringify(providerManifest)) as unknown,
    providerDid,
  );
  if (!providerVerdict.ok) {
    out(`  provider manifest did not verify: ${providerVerdict.reason}`);
    return 1;
  }
  const verifiedProvider: VerifiedProvider = providerVerdict.provider;

  const parties = {
    hirer: {
      did: deriveDidFromSigningKey(hirerKp.publicKey),
      signingPublicKeyBase64: util.encodeBase64(hirerKp.publicKey),
      sign: (bytes: Uint8Array) => nacl.sign.detached(bytes, hirerKp.secretKey),
    },
    provider: verifiedProvider,
    service: { ref: SERVICE_REF },
    task: { brief: BRIEF },
    price: {
      chain: CHAIN,
      asset,
      payerAccount,
      payeeAccount,
      minAmount: amount,
      maxAmount: amount,
    },
    ttl: { offerMs: 60 * 60_000, grantMs: GRANT_TTL_MS },
    nowMs,
  };

  const hire = seed === null
    ? await buildHire(parties)
    : await privateHire({ ...parties, entropy: await seededEntropy(seed) });
  if (!hire.ok) {
    out(`  buildHire refused: ${hire.reason}`);
    return 1;
  }

  const grantHash = await envelopeHash(hire.wire.grant as never);
  out();
  out(`  grant_hash           ${grantHash}`);
  check(hire.keep.grant_hash === grantHash, "keep.grant_hash equals the recomputed envelope hash");

  rule("4. THE EXACT TYPED DATA A WALLET WOULD BE ASKED TO SIGN");

  const nonce = await settlementNonce(grantHash);
  const validAfter = 0;
  const validBefore = Math.floor(nowMs / 1000) + AUTHORIZATION_WINDOW_SECONDS;

  const built = await buildTransferAuthorizationTypedData({
    chain: CHAIN,
    from: payerAccount,
    to: payeeAccount,
    value: amount,
    validAfter,
    validBefore,
    grantHash,
  });
  if (!built.ok) {
    out(`  the authorization was refused before it was signed: ${built.reason}`);
    return 1;
  }

  out(JSON.stringify(built.typedData, null, 2).split("\n").map((l) => `  ${l}`).join("\n"));
  out();
  check(
    built.typedData.message.nonce === nonce,
    "the EIP-3009 nonce IS sha256(SETTLEMENT_BINDING_DOMAIN || grant_hash)",
    nonce,
  );
  check(
    built.typedData.domain.verifyingContract === token,
    "the verifyingContract is the frozen Base USDC deployment",
  );
  out();
  out("  THIS IS THE BINDING. A payment carrying any other nonce — including the");
  out("  32 random bytes @x402/evm's createNonce() mints, which has no override —");
  out("  settles on chain and can never be tied to this grant. The money moves and");
  out("  the redemption answers `settlement_binding_mismatch` forever.");
  out();
  out(`  validAfter  ${validAfter}   validBefore ${validBefore}  (UNIX SECONDS)`);
  out(`              the authorization expires ${new Date(validBefore * 1000).toISOString()}`);

  rule("5. THE TRANSACTION THAT WOULD BE SENT");

  const PLACEHOLDER_R = `0x${"11".repeat(32)}`;
  const PLACEHOLDER_S = `0x${"22".repeat(32)}`;
  let signature = suppliedSignature;
  if (signature !== null && !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    out("  VOIDLY_DRYRUN_SIGNATURE is not `0x` + 130 hex. Ignoring it.");
    signature = null;
  }
  const usingPlaceholder = signature === null;
  const sig = signature ?? `${PLACEHOLDER_R}${PLACEHOLDER_S.slice(2)}1b`;

  const signed: SignedTransferAuthorization = Object.freeze({
    typedData: built.typedData,
    signature: sig.toLowerCase(),
    v: Number.parseInt(sig.slice(130, 132), 16),
    r: `0x${sig.slice(2, 66)}`,
    s: `0x${sig.slice(66, 130)}`,
    chain: CHAIN,
    grantHash,
  });

  const calldata = buildTransferWithAuthorizationCalldata(signed);
  if (!calldata.ok) {
    out(`  the calldata was refused: ${calldata.reason} — ${calldata.detail}`);
    return 1;
  }
  out(`  from      ${PAYEE}   ← THE PAYEE RELAYS. It pays gas; the payer pays USDC.`);
  out(`  to        ${calldata.request.to}   (Base USDC)`);
  out(`  value     ${calldata.request.value}   (USDC moves in the call, never as native value)`);
  out(`  chainId   ${calldata.request.chainId}`);
  out(`  selector  ${TRANSFER_WITH_AUTHORIZATION_SELECTOR}   transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)`);
  out();
  out("  data:");
  const body = calldata.request.data.slice(10);
  const labels = ["from", "to", "value", "validAfter", "validBefore", "nonce", "v", "r", "s"];
  out(`    ${calldata.request.data.slice(0, 10)}                                                           selector`);
  for (let i = 0; i < 9; i++) {
    out(`    ${body.slice(i * 64, (i + 1) * 64)}  ${labels[i]}`);
  }
  if (usingPlaceholder) {
    out();
    out("  ⚠ THE SIGNATURE ABOVE IS A PLACEHOLDER, not the payer's. r and s are");
    out("    0x1111… and 0x2222…, which no key produced. The simulation below is");
    out("    therefore expected to revert on the signature check — and that revert");
    out("    is itself informative: it proves the selector routed to the right");
    out("    function and the contract got as far as verifying a signature.");
  }

  rule("6. THE SIMULATION, AGAINST BASE MAINNET, READ-ONLY");

  const simRes = await rpc.request("eth_call", [
    { from: PAYEE, to: calldata.request.to, data: calldata.request.data, value: "0x0" },
    "latest",
  ]);
  out(`  eth_call from ${PAYEE}`);
  if (simRes.ok) {
    out(`  -> RETURNED ${String(simRes.result)}`);
    out();
    out("  THE TRANSFER WOULD SUCCEED at the head of the chain.");
  } else {
    out(`  -> ${simRes.reason}: ${simRes.detail}`);
    const raw = revertDataFromRpcError(simRes.detail);
    const reason = raw ? decodeRevertReason(raw) : null;
    out();
    if (reason) {
      out(`  REVERT REASON: ${JSON.stringify(reason)}`);
      if (usingPlaceholder && /signature/i.test(reason)) {
        out();
        out("  EXPECTED, and it is the good outcome for a run with no signature: the");
        out("  contract routed the call, read the validity window, and rejected the");
        out("  placeholder at `ecrecover`. Supply VOIDLY_DRYRUN_SIGNATURE to go further.");
      }
    } else {
      out("  The node did not return a decodable revert reason.");
    }
  }

  const gasRes = await rpc.request("eth_estimateGas", [
    { from: PAYEE, to: calldata.request.to, data: calldata.request.data, value: "0x0" },
  ]);
  const priceRes = await rpc.request("eth_gasPrice", []);
  const gasPrice = priceRes.ok ? hexToBigInt(priceRes.result) : null;
  const gas = gasRes.ok ? hexToBigInt(gasRes.result) : null;

  out();
  out(`  eth_gasPrice     -> ${priceRes.ok ? String(priceRes.result) : `FAILED ${priceRes.reason}`}${gasPrice === null ? "" : `  (${gasPrice} wei)`}`);
  out(`  eth_estimateGas  -> ${gasRes.ok ? String(gasRes.result) : `FAILED — ${gasRes.detail}`}`);

  const REFERENCE_GAS = BigInt(110_000);
  const gasForCost = gas ?? REFERENCE_GAS;
  if (gasPrice !== null) {
    const cost = gasForCost * gasPrice;
    out();
    out(`  COST TO THE RELAYER (the payee):`);
    out(`    ${gasForCost} gas${gas === null ? " (reference, since the estimate failed)" : ""} x ${gasPrice} wei = ${cost} wei`);
    out(`    = ${weiToEth(cost)} ETH`);
    if (payeeEth !== null) {
      out(`    the payee holds ${weiToEth(payeeEth)} ETH → about ${payeeEth / cost} more payments' worth of gas`);
    }
  }

  out();
  out("  BALANCES IF THIS TRANSACTION CONFIRMED:");
  if (payerUsdc !== null && payeeUsdc !== null) {
    out(`    payer USDC  ${atomicToUsdc(payerUsdc)} → ${atomicToUsdc(payerUsdc - BigInt(amount))}`);
    out(`    payee USDC  ${atomicToUsdc(payeeUsdc)} → ${atomicToUsdc(payeeUsdc + BigInt(amount))}`);
  }
  if (payeeEth !== null && gasPrice !== null) {
    out(`    payee ETH   ${weiToEth(payeeEth)} → ${weiToEth(payeeEth - gasForCost * gasPrice)}  (gas only)`);
  }
  if (payerEth !== null) {
    out(`    payer ETH   ${weiToEth(payerEth)} → unchanged. The payer signs gaslessly.`);
  }

  out();
  out("  AND THEN, ON THE RAIL:");
  out(`    the provider presents  ${JSON.stringify(x402SessionEvidence(`0x${"00".repeat(32)}`)).replace(`0x${"00".repeat(32)}`, "<the transaction hash>")}`);
  out(`    the adapter waits for  ${MIN_CONFIRMATIONS} confirmations, answering \`indeterminate\` until then`);
  out(`    it reads the nonce off AuthorizationUsed and reports it verbatim`);
  out(`    redeem.ts compares that against  ${nonce.slice(2)}`);
  out(`    an \`indeterminate\` costs NOTHING — settlement resolves before the atomic`);
  out(`    claim, so the same evidence resolves on a later call`);

  rule("7. THE REFUSAL, DEMONSTRATED RATHER THAN PROMISED");

  out("  This program's only network client is `createReadOnlyEvmRpc`, whose method");
  out("  allowlist is checked BEFORE the fetch. Attempting to broadcast, right now:");
  out();
  let refusedAll = true;
  for (const method of FORBIDDEN_RPC_METHODS) {
    const res = await rpc.request(method, ["0xf86c0a8502540be400825208…"]);
    const refused = !res.ok && res.reason === "rpc_method_not_read_only";
    if (!refused) refusedAll = false;
    out(`    ${method.padEnd(26)} -> ${refused ? "REFUSED before any I/O" : "NOT REFUSED — this is a defect"}`);
  }
  check(refusedAll, "every write method is refused by the client this program holds");
  out();
  out("  ┌────────────────────────────────────────────────────────────────────────┐");
  out("  │  NOTHING WAS BROADCAST. NO MONEY MOVED. NOTHING WAS WRITTEN ANYWHERE.  │");
  out("  │                                                                        │");
  out("  │  This program has no sender, holds no key, and cannot acquire one.     │");
  out("  │  Sending the transaction is a separate act by a separate program, run  │");
  out("  │  by the founder. This one only says what that program would do.        │");
  out("  └────────────────────────────────────────────────────────────────────────┘");

  rule("SUMMARY");
  if (problems === 0 && unknowns === 0) {
    out("  Every checked fact matched. The payload above is the one to sign.");
  } else if (problems === 0) {
    out(`  Every fact that could be READ matched. ${unknowns} read(s) did not come back —`);
    out("  the node was busy or unreachable — so those are UNKNOWN, not wrong. Re-run,");
    out("  or point VOIDLY_DRYRUN_RPC_URL at a different operator, before signing.");
  } else {
    out(`  ${problems} check(s) did NOT match. Read section 1 before signing anything.`);
    if (unknowns > 0) out(`  A further ${unknowns} read(s) did not come back and are UNKNOWN, not wrong.`);
  }
  out();
  out("  TO RE-RUN THIS EXACT HIRE — same grant hash, same nonce, same typed data:");
  out(`    VOIDLY_DRYRUN_SEED='${seed ?? "<choose a long random string>"}' \\`);
  out(`    VOIDLY_DRYRUN_NOW_MS=${nowMs} \\`);
  out(`    VOIDLY_DRYRUN_AMOUNT=${amount} \\`);
  out(`    VOIDLY_DRYRUN_RPC_URL=${rpcUrl} \\`);
  out("    node voidly-session-sdk/scripts/dry-run-base-mainnet-payment.mjs");
  if (seed === null) {
    out();
    out("    (this run used fresh entropy, so the seed above is a blank to fill in;");
    out("     the FIRST seeded run is the one whose typed data you sign)");
  }

  if (usingPlaceholder) {
    out();
    out("  No real signature was supplied, so the simulation exercised the contract");
    out("  but not this payment. To go further:");
    out("    1. sign the section-4 typed data with the payer's wallet;");
    out("    2. re-run with VOIDLY_DRYRUN_SIGNATURE=0x…130 hex;");
    out("    3. section 6 will then report the real gas and the real outcome.");
    out();
    out("  The signature must be over the SEEDED hire — with no seed, or with a");
    out("  different clock, the grant hash and therefore the nonce move, and the");
    out("  signature would be for a hire that does not exist.");
  }
  out();
  return problems === 0 ? 0 : 1;
}

if (process.env.VOIDLY_DRYRUN_AUTOSTART === "1") {
  dryRun().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`dry run failed: ${err instanceof Error ? err.stack : String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
