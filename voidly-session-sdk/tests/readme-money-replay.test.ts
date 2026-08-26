
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const REVERT_GAS = 40_895;
const RELAY_GAS = 85_747;
const PRICE = 10_000n;

const RECEIVE_BUILDER = "buildReceivePaymentAuthorization";
const TRANSFER_BUILDER = "buildTransferPaymentAuthorization";
const PAY_DOOR = "payForGrant";
const SUBMIT_DOOR = "submitHire";
const HINT_DOOR = "submitSettlementHint";
const DOORS = [RECEIVE_BUILDER, TRANSFER_BUILDER, PAY_DOOR, SUBMIT_DOOR, HINT_DOOR] as const;
type Door = (typeof DOORS)[number];

function codeOf(block: string): string {
  let out = "";
  let i = 0;
  while (i < block.length) {
    const c = block[i];
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      i++;
      while (i < block.length) {
        if (block[i] === "\\") { out += block[i] + (block[i + 1] ?? ""); i += 2; continue; }
        out += block[i];
        if (block[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    if (c === "/" && block[i + 1] === "/") {
      while (i < block.length && block[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && block[i + 1] === "*") {
      i += 2;
      while (i < block.length && !(block[i] === "*" && block[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function sequenceOf(block: string): Door[] {
  const code = codeOf(block);
  const found: Array<{ at: number; door: Door }> = [];
  for (const door of DOORS) {
    const re = new RegExp(`\\b${door}\\s*\\(`, "g");
    for (let m = re.exec(code); m !== null; m = re.exec(code)) {
      found.push({ at: m.index, door });
    }
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.door);
}

type Variant = "receive" | "transfer";

interface Tx {
  readonly selector: "receiveWithAuthorization" | "transferWithAuthorization";
  readonly sender: "payer" | "payee";
  readonly reverted: boolean;
  readonly gas: number;
  readonly moved: bigint;
}

interface Replay {
  readonly txs: readonly Tx[];
  readonly reverted: number;
  readonly gasWastedOnReverts: number;
  readonly spends: number;
  readonly moved: bigint;
  readonly unassemblable: number;
}

function replay(
  sequence: readonly Door[],
  opts: { readonly daemonRelays: boolean; readonly daemonTick: "after_submit" | "at_end" },
): Replay {
  const burned = new Set<string>();
  const NONCE = "settlementBindingReference(grantHash)";
  const txs: Tx[] = [];

  let hirerHolds: Variant | null = null;
  let providerHolds: Variant | null = null;
  let hirerPointer = false;
  let daemonHadItsTurn = false;
  let unassemblable = 0;

  const spend = (variant: Variant, sender: "payer" | "payee"): void => {
    if (variant === "receive" && sender !== "payee") return;
    const selector = variant === "receive" ? "receiveWithAuthorization" : "transferWithAuthorization";
    if (burned.has(NONCE)) {
      txs.push({ selector, sender, reverted: true, gas: REVERT_GAS, moved: 0n });
      return;
    }
    burned.add(NONCE);
    txs.push({
      selector,
      sender,
      reverted: false,
      gas: variant === "receive" ? RELAY_GAS : RELAY_GAS,
      moved: PRICE,
    });
  };

  const daemonTurn = (): void => {
    if (daemonHadItsTurn) return;
    if (!daemonRelaysNow()) return;
    daemonHadItsTurn = true;
    if (providerHolds === "transfer") {
      unassemblable += 1;
      return;
    }
    if (providerHolds === "receive") spend("receive", "payee");
  };
  const daemonRelaysNow = (): boolean =>
    opts.daemonRelays && providerHolds !== null && !hirerPointer;

  for (const door of sequence) {
    switch (door) {
      case RECEIVE_BUILDER: hirerHolds = "receive"; break;
      case TRANSFER_BUILDER: hirerHolds = "transfer"; break;
      case SUBMIT_DOOR:
        providerHolds = hirerHolds;
        if (opts.daemonTick === "after_submit") daemonTurn();
        break;
      case PAY_DOOR:
        spend("transfer", "payer");
        break;
      case HINT_DOOR: hirerPointer = true; break;
    }
  }
  if (opts.daemonTick === "at_end") daemonTurn();

  const reverted = txs.filter((t) => t.reverted);
  return {
    txs,
    reverted: reverted.length,
    gasWastedOnReverts: reverted.reduce((n, t) => n + t.gas, 0),
    spends: txs.filter((t) => !t.reverted).length,
    moved: txs.reduce((n, t) => n + t.moved, 0n),
    unassemblable,
  };
}

const WORLDS = [
  { daemonRelays: true, daemonTick: "after_submit" as const, name: "relaying daemon, tick after submit" },
  { daemonRelays: true, daemonTick: "at_end" as const, name: "relaying daemon, tick last" },
  { daemonRelays: false, daemonTick: "at_end" as const, name: "hirer-pays daemon (no relayer)" },
];

describe("README.md, replayed against the token", () => {
  const md = readFileSync(resolve(PKG_DIR, "README.md"), "utf8");
  const blocks = [...md.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1]);

  it("POSITIVE CONTROL: a sequence that stages both halves reverts, and burns gas", () => {
    const headSequence: Door[] = [RECEIVE_BUILDER, SUBMIT_DOOR, PAY_DOOR, HINT_DOOR];
    const out = replay(headSequence, { daemonRelays: true, daemonTick: "after_submit" });

    expect(out.reverted, "the model no longer reverts a second spend of a burned nonce").toBe(1);
    expect(out.gasWastedOnReverts).toBe(REVERT_GAS);
    expect(out.spends, "the money still moved exactly once — that is what makes it a silent loss").toBe(1);
    expect(out.moved).toBe(PRICE);
    expect(out.txs.map((t) => `${t.selector}:${t.reverted ? "reverted" : "ok"}`)).toEqual([
      "receiveWithAuthorization:ok",
      "transferWithAuthorization:reverted",
    ]);
  });

  it("NO README EXAMPLE PRODUCES A REVERTED TRANSACTION OR WASTED GAS, under any daemon", () => {
    expect(blocks.length, "README.md carries no ```ts example to replay").toBeGreaterThan(0);

    for (const [i, block] of blocks.entries()) {
      const sequence = sequenceOf(block);
      if (sequence.length === 0) continue;
      for (const world of WORLDS) {
        const out = replay(sequence, world);
        const trace = `block ${i} [${sequence.join(" -> ")}] under ${world.name}`;
        expect(
          out.reverted,
          `${trace} produces ${out.reverted} REVERTED transaction(s), burning ` +
            `${out.gasWastedOnReverts} gas for nothing. Both payment builders mint ` +
            "settlementBindingReference(grantHash) as the nonce and USDC marks " +
            "(authorizer, nonce) consumed on first use, so the second spend cannot " +
            "succeed — and `payForGrant` still answers ok:true with its hash, because " +
            "no submitter here waits for a receipt. The two paths are ALTERNATIVES: " +
            "split them into separate blocks, or drop one.",
        ).toBe(0);
        expect(out.gasWastedOnReverts, `${trace} burns gas on a revert`).toBe(0);
        expect(
          out.spends,
          `${trace} spends the binding nonce ${out.spends} times. One grant is one ` +
            "payment; a second success is impossible and a second attempt is a loss.",
        ).toBeLessThanOrEqual(1);
        expect(
          out.moved === 0n || out.moved === PRICE,
          `${trace} moved ${out.moved} micro-USDC against a price of ${PRICE}`,
        ).toBe(true);
      }
    }
  });

  it("BOTH HALVES OF THE FORK ARE STILL DOCUMENTED, in blocks that never meet", () => {
    const seqs = blocks.map(sequenceOf);
    const receiveBlocks = seqs.filter((s) => s.includes(RECEIVE_BUILDER));
    const transferBlocks = seqs.filter((s) => s.includes(TRANSFER_BUILDER) || s.includes(PAY_DOOR));

    expect(
      receiveBlocks.length,
      "no README example builds a RECEIVE authorization. That is the DEFAULT — the " +
        "only variant the token restricts to the payee it names — and a document " +
        "without it teaches every reader to send a bearer payload instead.",
    ).toBeGreaterThan(0);
    expect(
      transferBlocks.length,
      "no README example takes the opt-out. A hirer whose provider does not relay " +
        "has no other way to pay, and this is the document that was supposed to " +
        "tell it how.",
    ).toBeGreaterThan(0);
    expect(
      seqs.some((s) => s.includes(RECEIVE_BUILDER) && (s.includes(TRANSFER_BUILDER) || s.includes(PAY_DOOR))),
      "one block reaches both halves of the fork — see the replay assertion above.",
    ).toBe(false);
  });

  it("THE README'S OWN TTLs ARE ACCEPTED BY THE PROTOCOL'S NESTING RULE", () => {
    const MIN_GRANT_TTL_MS = 12 * 2_000 + 30_000;
    const MAX_TTL_MS = 24 * 60 * 60 * 1000;
    const evaluate = (expr: string): number =>
      expr
        .split("*")
        .map((part) => Number(part.trim().replace(/_/g, "")))
        .reduce((a, b) => a * b, 1);

    let seen = 0;
    for (const [i, block] of blocks.entries()) {
      const code = codeOf(block);
      const re = /ttl:\s*\{\s*offerMs:\s*([^,]+),\s*grantMs:\s*([^,}]+)/g;
      for (let m = re.exec(code); m !== null; m = re.exec(code)) {
        seen++;
        const offerMs = evaluate(m[1]);
        const grantMs = evaluate(m[2]);
        expect(Number.isFinite(offerMs) && Number.isFinite(grantMs), `block ${i}: unreadable ttl`).toBe(true);
        expect(
          grantMs <= offerMs,
          `README ts block ${i} asks for a grant of ${grantMs}ms under an offer of ` +
            `${offerMs}ms. An authorization can never outlive the terms it points at, ` +
            "so `buildHire` refuses this `invalid_ttl` — before the wallet is touched, " +
            "and on every provider. The document's own end-to-end example cannot " +
            "build a hire.",
        ).toBe(true);
        expect(grantMs, `README ts block ${i}: grantMs is under the rail's floor`)
          .toBeGreaterThanOrEqual(MIN_GRANT_TTL_MS);
        expect(offerMs, `README ts block ${i}: offerMs exceeds the protocol ceiling`)
          .toBeLessThanOrEqual(MAX_TTL_MS);
      }
    }
    expect(seen, "no README example passes a `ttl` — the bound is unexercised").toBeGreaterThan(0);
  });

  it("NO RECEIVE-VARIANT EXAMPLE SENDS A SETTLEMENT HINT", () => {
    for (const [i, block] of blocks.entries()) {
      const sequence = sequenceOf(block);
      if (!sequence.includes(RECEIVE_BUILDER)) continue;
      expect(
        sequence.includes(HINT_DOOR),
        `README ts block ${i} builds a RECEIVE authorization and also calls ` +
          "`submitSettlementHint`. The provider authors that pointer; the hirer's is " +
          "refused 409 hint_too_late, permanently and by design.",
      ).toBe(false);
    }
  });

  it("THE OPT-OUT HINTS AFTER IT PAYS", () => {
    for (const [i, block] of blocks.entries()) {
      const sequence = sequenceOf(block);
      if (!sequence.includes(PAY_DOOR)) continue;
      const pay = sequence.indexOf(PAY_DOOR);
      const hint = sequence.indexOf(HINT_DOOR);
      expect(
        hint,
        `README ts block ${i} pays but never points the provider at the payment. ` +
          "`redeemAndOpen` hard-refuses `no_settlement_hint`, so the session dies " +
          "paid and unredeemed.",
      ).toBeGreaterThan(-1);
      expect(
        hint > pay,
        `README ts block ${i} sends the settlement hint before the payment exists.`,
      ).toBe(true);
    }
  });
});
