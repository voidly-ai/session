
import type { ReadOnlyEvmRpc } from "./relay";

export const RELAY_GAS_UNITS = 102_883n;

export const WIRE_MULTIPLE = 3n;

export const QUOTE_MULTIPLE = 12n;

export interface RelayCostFacts {
  readonly gasPriceWei: bigint;
  readonly gasUnits: bigint;
  readonly l1DataFeeWei: bigint;
  readonly nativeUsd: bigint;
  readonly nativeUsdDecimals: number;
  readonly assetDecimals: number;
}

export type BreakEvenRefusal =
  | "gas_price_unreadable"
  | "l1_fee_unreadable"
  | "native_price_unreadable"
  | "native_price_not_positive"
  | "native_price_stale";

export type BreakEvenResult =
  | { readonly ok: true; readonly breakEven: bigint; readonly costWei: bigint }
  | { readonly ok: false; readonly reason: BreakEvenRefusal; readonly detail: string };

function pow10(n: number): bigint {
  let out = 1n;
  for (let i = 0; i < n; i++) out *= 10n;
  return out;
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return a % b === 0n ? a / b : a / b + 1n;
}

export function breakEvenSmallestUnits(facts: RelayCostFacts): bigint {
  const costWei = facts.gasUnits * facts.gasPriceWei + facts.l1DataFeeWei;
  const numerator = costWei * facts.nativeUsd * pow10(facts.assetDecimals);
  const denominator = pow10(18) * pow10(facts.nativeUsdDecimals);
  return ceilDiv(numerator, denominator);
}

export function relayFloorSmallestUnits(facts: RelayCostFacts, multiple: bigint): bigint {
  if (multiple <= 0n) throw new Error("relayFloorSmallestUnits: multiple must be positive");
  return breakEvenSmallestUnits(facts) * multiple;
}

export type ConfiguredFloorVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "configured_min_amount_below_break_even";
      readonly detail: string;
    };

export function checkConfiguredFloor(input: {
  readonly configuredMinAmount: string;
  readonly facts: RelayCostFacts;
  readonly multiple: bigint;
}): ConfiguredFloorVerdict {
  const floor = relayFloorSmallestUnits(input.facts, input.multiple);
  let configured: bigint;
  try {
    if (!/^[0-9]+$/.test(input.configuredMinAmount)) throw new Error("not a decimal string");
    configured = BigInt(input.configuredMinAmount);
  } catch {
    return {
      ok: false,
      reason: "configured_min_amount_below_break_even",
      detail:
        `minAmount ${JSON.stringify(input.configuredMinAmount)} is not a decimal string in the ` +
        `asset's smallest unit, so it cannot be compared with the derived floor of ${floor}.`,
    };
  }
  if (configured >= floor) return { ok: true };
  const breakEven = breakEvenSmallestUnits(input.facts);
  return {
    ok: false,
    reason: "configured_min_amount_below_break_even",
    detail:
      `minAmount is set to ${configured} and one relay costs ${breakEven} right now ` +
      `(${input.facts.gasUnits} gas at ${input.facts.gasPriceWei} wei plus ${input.facts.l1DataFeeWei} ` +
      `wei of L1 data fee, at ${input.facts.nativeUsd} / 1e${input.facts.nativeUsdDecimals} per native ` +
      `unit). At ${input.multiple}x that is a floor of ${floor}. Serving at ${configured} pays ` +
      `${configured} of the asset in and spends the equivalent of ${breakEven} of native currency ` +
      `out on every job, which shows up as revenue growth until the gas wallet empties and every ` +
      `accepted row answers relayer_cannot_pay_gas at once. Set VOIDLY_PRICE_MIN_AMOUNT to at ` +
      `least ${floor}.`,
  };
}

export type OfferedAmountVerdict =
  | { readonly ok: true; readonly floor: bigint }
  | { readonly ok: false; readonly reason: "price_below_break_even"; readonly detail: string };

export function checkOfferedAmount(input: {
  readonly amount: string;
  readonly facts: RelayCostFacts;
  readonly multiple: bigint;
}): OfferedAmountVerdict {
  const floor = relayFloorSmallestUnits(input.facts, input.multiple);
  let amount: bigint;
  try {
    if (!/^[0-9]+$/.test(input.amount)) throw new Error("not a decimal string");
    amount = BigInt(input.amount);
  } catch {
    return {
      ok: false,
      reason: "price_below_break_even",
      detail: `amount ${JSON.stringify(input.amount)} is not a decimal string; refused as below the floor of ${floor}.`,
    };
  }
  if (amount >= floor) return { ok: true, floor };
  return {
    ok: false,
    reason: "price_below_break_even",
    detail:
      `this hire pays ${amount} and relaying it costs ${breakEvenSmallestUnits(input.facts)} at the ` +
      `chain state read a moment ago, so the floor is ${floor}. Accepting would countersign a ` +
      `promise to lose money on a job that has not been done yet.`,
  };
}

export const GAS_PRICE_ORACLE = "0x420000000000000000000000000000000000000f";

export const CHAINLINK_ETH_USD_BASE = "0x71041dddad3595f9ced3dccfbe3d1f4b0a16bb70";

const SEL_LATEST_ROUND_DATA = "0xfeaf968c";
const SEL_GET_L1_FEE = "0x49948e0e";

function words(hex: string): bigint[] {
  const body = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out: bigint[] = [];
  for (let i = 0; i + 64 <= body.length; i += 64) out.push(BigInt("0x" + body.slice(i, i + 64)));
  return out;
}

function asInt256(u: bigint): bigint {
  return u >= 1n << 255n ? u - (1n << 256n) : u;
}

function encodeBytesArg(rawHex: string): string {
  const body = rawHex.startsWith("0x") ? rawHex.slice(2) : rawHex;
  const len = body.length / 2;
  const pad = "0".repeat(((32 - (len % 32)) % 32) * 2);
  return (
    (32n).toString(16).padStart(64, "0") + BigInt(len).toString(16).padStart(64, "0") + body + pad
  );
}

export type FactsResult =
  | { readonly ok: true; readonly facts: RelayCostFacts; readonly updatedAtSeconds: bigint }
  | { readonly ok: false; readonly reason: BreakEvenRefusal; readonly detail: string };

export async function readRelayCostFacts(input: {
  readonly rpc: ReadOnlyEvmRpc;
  readonly rawTransactionHex: string;
  readonly priceFeed: string;
  readonly nowSeconds: bigint;
  readonly maxPriceAgeSeconds: bigint;
  readonly gasUnits: bigint;
  readonly assetDecimals: number;
}): Promise<FactsResult> {
  const priceRes = await input.rpc.request("eth_gasPrice", []);
  if (!priceRes.ok || typeof priceRes.result !== "string") {
    return {
      ok: false,
      reason: "gas_price_unreadable",
      detail: priceRes.ok ? `unreadable gas price ${String(priceRes.result)}` : `${priceRes.reason}: ${priceRes.detail}`,
    };
  }
  let gasPriceWei: bigint;
  try {
    gasPriceWei = BigInt(priceRes.result);
  } catch {
    return { ok: false, reason: "gas_price_unreadable", detail: `unreadable gas price ${priceRes.result}` };
  }

  const l1Res = await input.rpc.request("eth_call", [
    { to: GAS_PRICE_ORACLE, data: SEL_GET_L1_FEE + encodeBytesArg(input.rawTransactionHex) },
    "latest",
  ]);
  if (!l1Res.ok || typeof l1Res.result !== "string" || words(l1Res.result).length < 1) {
    return {
      ok: false,
      reason: "l1_fee_unreadable",
      detail: l1Res.ok
        ? `GasPriceOracle.getL1Fee returned ${String(l1Res.result)}`
        : `${l1Res.reason}: ${l1Res.detail}`,
    };
  }
  const l1DataFeeWei = words(l1Res.result)[0];

  const feedRes = await input.rpc.request("eth_call", [
    { to: input.priceFeed, data: SEL_LATEST_ROUND_DATA },
    "latest",
  ]);
  if (!feedRes.ok || typeof feedRes.result !== "string" || words(feedRes.result).length < 5) {
    return {
      ok: false,
      reason: "native_price_unreadable",
      detail: feedRes.ok
        ? `latestRoundData returned ${String(feedRes.result)}`
        : `${feedRes.reason}: ${feedRes.detail}`,
    };
  }
  const w = words(feedRes.result);
  const answer = asInt256(w[1]);
  const updatedAtSeconds = w[3];
  if (answer <= 0n) {
    return {
      ok: false,
      reason: "native_price_not_positive",
      detail: `the price feed answered ${answer}. A non-positive price would make the floor zero or negative, which is the one value that cannot be refused against.`,
    };
  }
  if (updatedAtSeconds === 0n || input.nowSeconds - updatedAtSeconds > input.maxPriceAgeSeconds) {
    return {
      ok: false,
      reason: "native_price_stale",
      detail:
        `the price feed last updated at UNIX second ${updatedAtSeconds} and the clock reads ` +
        `${input.nowSeconds}, which is beyond the ${input.maxPriceAgeSeconds}s the caller allows. ` +
        "A stale price silently freezes the floor at whatever the token was worth when the feed stopped.",
    };
  }

  const decRes = await input.rpc.request("eth_call", [{ to: input.priceFeed, data: "0x313ce567" }, "latest"]);
  if (!decRes.ok || typeof decRes.result !== "string" || words(decRes.result).length < 1) {
    return {
      ok: false,
      reason: "native_price_unreadable",
      detail: decRes.ok ? `decimals() returned ${String(decRes.result)}` : `${decRes.reason}: ${decRes.detail}`,
    };
  }

  return {
    ok: true,
    updatedAtSeconds,
    facts: {
      gasPriceWei,
      gasUnits: input.gasUnits,
      l1DataFeeWei,
      nativeUsd: answer,
      nativeUsdDecimals: Number(words(decRes.result)[0]),
      assetDecimals: input.assetDecimals,
    },
  };
}
