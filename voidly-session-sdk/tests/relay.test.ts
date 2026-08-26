
import { describe, expect, it } from "vitest";
import { AbiCoder, id as keccakUtf8 } from "ethers";

import {
  AUTHORIZATION_USED_TOPIC0,
  buildReceiveWithAuthorizationCalldata,
  buildTransferWithAuthorizationCalldata,
  checkSingleAuthorizationRelay,
  createPayeeRelayBroadcaster,
  createReadOnlyEvmRpc,
  createSelfSubmitter,
  decodeRevertReason,
  estimateRelayCost,
  FORBIDDEN_RPC_METHODS,
  READ_ONLY_RPC_METHODS,
  RECEIVE_WITH_AUTHORIZATION_SELECTOR,
  RelayRefusal,
  resolveSettlementTransaction,
  simulateTransaction,
  TRANSFER_WITH_AUTHORIZATION_SELECTOR,
} from "../src/index";
import type {
  SignedReceiveAuthorization,
  SignedTransferAuthorization,
  TransactionRequest,
} from "../src/index";
import { checkRelayRemainingWindow } from "../src/relay";
import { MIN_GRANT_TTL_MS } from "../src/protocol";

const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const RELAYER = "0xb0b3fca940e04f99367f08e665e1c2cb4ebd4912";
const TX_HASH = `0x${"7f".repeat(32)}`;

const VALID_BEFORE = 1_900_000_000;
const HEAD_SECONDS = 1_899_993_600;

const w = (hexNo0x: string): string => hexNo0x.padStart(64, "0");

function eip3009Calldata({
  selector = TRANSFER_WITH_AUTHORIZATION_SELECTOR,
  to = RELAYER,
  validBefore = VALID_BEFORE,
}: { selector?: string; to?: string; validBefore?: number } = {}): string {
  return (
    selector +
    w("5cad296e06a976886a5d5bef831520c3d5965af0") +
    w(to.slice(2)) +
    w((1_000_000).toString(16)) +
    w("0") +
    w(validBefore.toString(16)) +
    w("ab".repeat(32)) +
    w("1b") +
    w("11".repeat(32)) +
    w("22".repeat(32))
  );
}

const REQUEST: TransactionRequest = Object.freeze({
  to: USDC,
  data: eip3009Calldata(),
  value: "0x0" as const,
  chainId: 8453,
});

function errorString(message: string): string {
  return `0x08c379a0${AbiCoder.defaultAbiCoder().encode(["string"], [message]).slice(2)}`;
}

interface Scripted {
  readonly [method: string]: unknown;
}

function scriptedRpc(script: Scripted) {
  const asked: string[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { method: string; id: number };
    asked.push(body.method);
    if (!(body.method in script)) throw new Error(`unscripted method ${body.method}`);
    const scripted = script[body.method] as { error?: unknown };
    const payload =
      scripted && typeof scripted === "object" && "error" in scripted
        ? { jsonrpc: "2.0", id: body.id, error: scripted.error }
        : { jsonrpc: "2.0", id: body.id, result: scripted };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return {
    asked,
    rpc: createReadOnlyEvmRpc({ url: "https://rpc.example.test", fetchImpl: fetchImpl as never }),
  };
}

const HEALTHY: Scripted = {
  eth_chainId: "0x2105",
  eth_getBlockByNumber: {
    number: "0x2fe1de0",
    timestamp: `0x${HEAD_SECONDS.toString(16)}`,
  },
  eth_call: "0x",
  eth_estimateGas: "0x1adb0",
  eth_gasPrice: "0x5b8d80",
  eth_getBalance: "0x970e42706b000",
};

function countingSend(reply: string | (() => string) = TX_HASH) {
  const calls: Array<{ gasLimit: bigint; gasPriceWei: bigint; to: string }> = [];
  return {
    calls,
    send: (t: { gasLimit: bigint; gasPriceWei: bigint; to: string }) => {
      calls.push({ gasLimit: t.gasLimit, gasPriceWei: t.gasPriceWei, to: t.to });
      return typeof reply === "function" ? reply() : reply;
    },
  };
}

describe("the RPC client reads and cannot write", () => {
  it("refuses a write method before touching the injected fetch", async () => {
    let fetches = 0;
    const rpc = createReadOnlyEvmRpc({
      url: "https://rpc.example.test",
      fetchImpl: (async () => {
        fetches++;
        return new Response("{}", { status: 200 });
      }) as never,
    });
    const res = await rpc.request("eth_sendRawTransaction", ["0xf86c…"]);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("rpc_method_not_read_only");
    expect(fetches).toBe(0);
  });

  it("refuses cleartext, because this read decides whether to spend money", async () => {
    let fetches = 0;
    const rpc = createReadOnlyEvmRpc({
      url: "http://rpc.example.test",
      fetchImpl: (async () => {
        fetches++;
        return new Response("{}", { status: 200 });
      }) as never,
    });
    const res = await rpc.request("eth_chainId", []);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("rpc_url_not_https");
    expect(fetches).toBe(0);
  });

  it("a JSON-RPC error member is `rpc_error`, not a result", async () => {
    const { rpc } = scriptedRpc({ eth_chainId: { error: { code: -32016, message: "over rate limit" } } });
    const res = await rpc.request("eth_chainId", []);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("rpc_error");
    expect(res.detail).toContain("over rate limit");
  });

  it("2xx JSON with neither result nor error is malformed, never an empty success", async () => {
    const rpc = createReadOnlyEvmRpc({
      url: "https://rpc.example.test",
      fetchImpl: (async () =>
        new Response('{"jsonrpc":"2.0","id":1}', {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as never,
    });
    const res = await rpc.request("eth_chainId", []);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("rpc_result_malformed");
  });

  it("every allowlisted method actually reaches the node", async () => {
    const script: Record<string, unknown> = {};
    for (const m of READ_ONLY_RPC_METHODS) script[m] = "0x1";
    const { rpc, asked } = scriptedRpc(script);
    for (const m of READ_ONLY_RPC_METHODS) {
      const res = await rpc.request(m, []);
      expect(res.ok, m).toBe(true);
    }
    expect(asked).toEqual([...READ_ONLY_RPC_METHODS]);
  });
});

describe("a revert is read for its reason, and an outage is not read as a revert", () => {
  it("decodes the strings FiatTokenV2 actually reverts with", () => {
    for (const message of [
      "FiatTokenV2: authorization is expired",
      "FiatTokenV2: authorization is used or canceled",
      "FiatTokenV2: invalid signature",
      "ERC20: transfer amount exceeds balance",
    ]) {
      expect(decodeRevertReason(errorString(message))).toBe(message);
    }
  });

  it("empty revert data yields null rather than an invented sentence", () => {
    expect(decodeRevertReason("0x")).toBe(null);
    expect(decodeRevertReason("0x4e487b710000000000000000000000000000000000000000000000000000000000000011")).toBe(null);
    expect(decodeRevertReason(undefined)).toBe(null);
  });

  it("simulateTransaction reports would_revert with the reason attached", async () => {
    const { rpc } = scriptedRpc({
      eth_call: {
        error: {
          code: 3,
          message: "execution reverted",
          data: errorString("FiatTokenV2: authorization is expired"),
        },
      },
    });
    const sim = await simulateTransaction({ rpc, request: REQUEST, from: RELAYER });
    expect(sim.kind).toBe("would_revert");
    if (sim.kind !== "would_revert") return;
    expect(sim.reason).toBe("FiatTokenV2: authorization is expired");
  });

  it("a rate limit is `unavailable`, NOT a revert", async () => {
    const { rpc } = scriptedRpc({
      eth_call: { error: { code: -32016, message: "over rate limit" } },
    });
    const sim = await simulateTransaction({ rpc, request: REQUEST, from: RELAYER });
    expect(sim.kind).toBe("unavailable");
  });

  it("a successful call is would_succeed", async () => {
    const { rpc } = scriptedRpc({ eth_call: "0x" });
    const sim = await simulateTransaction({ rpc, request: REQUEST, from: RELAYER });
    expect(sim.kind).toBe("would_succeed");
  });
});

describe("the relayer is asked whether it can pay before it is asked to pay", () => {
  it("applies the margin to the node's estimate and multiplies by the live price", async () => {
    const { rpc } = scriptedRpc(HEALTHY);
    const cost = await estimateRelayCost({
      rpc,
      request: REQUEST,
      from: RELAYER,
      gasLimitMarginPercent: 25,
    });
    expect(cost.ok).toBe(true);
    if (!cost.ok) return;
    expect(cost.cost.gas).toBe(BigInt(110_000));
    expect(cost.cost.gasLimit).toBe(BigInt(137_500));
    expect(cost.cost.gasPriceWei).toBe(BigInt(6_000_000));
    expect(cost.cost.maxCostWei).toBe(BigInt(137_500) * BigInt(6_000_000));
    expect(cost.cost.maxCostWei).toBe(BigInt(825_000_000_000));
    expect(cost.cost.relayerBalanceWei).toBeGreaterThan(cost.cost.maxCostWei);
  });

  it("a margin of 0 sends exactly what the node estimated", async () => {
    const { rpc } = scriptedRpc(HEALTHY);
    const cost = await estimateRelayCost({
      rpc,
      request: REQUEST,
      from: RELAYER,
      gasLimitMarginPercent: 0,
    });
    expect(cost.ok).toBe(true);
    if (!cost.ok) return;
    expect(cost.cost.gasLimit).toBe(cost.cost.gas);
  });

  it("a relayer that cannot cover the worst case is refused", async () => {
    const { rpc } = scriptedRpc({ ...HEALTHY, eth_getBalance: "0x1" });
    const cost = await estimateRelayCost({
      rpc,
      request: REQUEST,
      from: RELAYER,
      gasLimitMarginPercent: 25,
    });
    expect(cost.ok).toBe(false);
    if (cost.ok) return;
    expect(cost.reason).toBe("relayer_cannot_pay_gas");
  });

  it("an unreadable estimate is an outage, not a free transaction", async () => {
    const { rpc } = scriptedRpc({ ...HEALTHY, eth_estimateGas: "not-hex" });
    const cost = await estimateRelayCost({
      rpc,
      request: REQUEST,
      from: RELAYER,
      gasLimitMarginPercent: 25,
    });
    expect(cost.ok).toBe(false);
    if (cost.ok) return;
    expect(cost.reason).toBe("estimate_unavailable");
  });
});

describe("the broadcaster checks the chain, the call and the balance BEFORE sending", () => {
  it("the happy path sends once, with the gas it computed, and returns the hash", async () => {
    const { rpc, asked } = scriptedRpc(HEALTHY);
    const send = countingSend();
    const broadcast = createPayeeRelayBroadcaster({
      rpc,
      relayerAddress: RELAYER,
      send: send.send,
      gasLimitMarginPercent: 25,
    });
    const hash = await broadcast(REQUEST);
    expect(hash).toBe(TX_HASH);
    expect(send.calls.length).toBe(1);
    expect(send.calls[0].gasLimit).toBe(BigInt(137_500));
    expect(send.calls[0].to).toBe(USDC);
    expect(asked).toEqual([
      "eth_chainId",
      "eth_getBlockByNumber",
      "eth_call",
      "eth_estimateGas",
      "eth_gasPrice",
      "eth_getBalance",
    ]);
  });

  it("a chain-id mismatch refuses without sending", async () => {
    const { rpc } = scriptedRpc({ ...HEALTHY, eth_chainId: "0x14a34" });
    const send = countingSend();
    const broadcast = createPayeeRelayBroadcaster({
      rpc,
      relayerAddress: RELAYER,
      send: send.send,
      gasLimitMarginPercent: 25,
    });
    await expect(broadcast(REQUEST)).rejects.toBeInstanceOf(RelayRefusal);
    await broadcast(REQUEST).catch((e: RelayRefusal) => {
      expect(e.reason).toBe("chain_id_mismatch");
    });
    expect(send.calls.length).toBe(0);
  });

  it("a reverting simulation refuses without sending, and names the revert", async () => {
    const { rpc } = scriptedRpc({
      ...HEALTHY,
      eth_call: {
        error: {
          code: 3,
          message: "execution reverted",
          data: errorString("FiatTokenV2: authorization is used or canceled"),
        },
      },
    });
    const send = countingSend();
    const broadcast = createPayeeRelayBroadcaster({
      rpc,
      relayerAddress: RELAYER,
      send: send.send,
      gasLimitMarginPercent: 25,
    });
    await broadcast(REQUEST).then(
      () => expect.unreachable("a reverting call must not be sent"),
      (e: RelayRefusal) => {
        expect(e.reason).toBe("simulation_reverted");
        expect(e.message).toContain("authorization is used or canceled");
        expect(e.message).toContain("emits no AuthorizationUsed log");
      },
    );
    expect(send.calls.length).toBe(0);
  });

  it("an unavailable node refuses without sending — nothing was ruled out", async () => {
    const { rpc } = scriptedRpc({
      ...HEALTHY,
      eth_call: { error: { code: -32016, message: "over rate limit" } },
    });
    const send = countingSend();
    const broadcast = createPayeeRelayBroadcaster({
      rpc,
      relayerAddress: RELAYER,
      send: send.send,
      gasLimitMarginPercent: 25,
    });
    await broadcast(REQUEST).then(
      () => expect.unreachable("an unanswered simulation must not be sent"),
      (e: RelayRefusal) => expect(e.reason).toBe("simulation_unavailable"),
    );
    expect(send.calls.length).toBe(0);
  });

  it("an unfunded relayer refuses without sending", async () => {
    const { rpc } = scriptedRpc({ ...HEALTHY, eth_getBalance: "0x0" });
    const send = countingSend();
    const broadcast = createPayeeRelayBroadcaster({
      rpc,
      relayerAddress: RELAYER,
      send: send.send,
      gasLimitMarginPercent: 25,
    });
    await broadcast(REQUEST).then(
      () => expect.unreachable("an unfunded relayer must not send"),
      (e: RelayRefusal) => expect(e.reason).toBe("relayer_cannot_pay_gas"),
    );
    expect(send.calls.length).toBe(0);
  });

  it("a sender that throws says plainly that nothing is proven", async () => {
    const { rpc } = scriptedRpc(HEALTHY);
    const broadcast = createPayeeRelayBroadcaster({
      rpc,
      relayerAddress: RELAYER,
      send: () => {
        throw new Error("socket hang up");
      },
      gasLimitMarginPercent: 25,
    });
    await broadcast(REQUEST).then(
      () => expect.unreachable(),
      (e: RelayRefusal) => {
        expect(e.reason).toBe("send_threw");
        expect(e.message).toContain("NOT PROOF NOTHING HAPPENED");
      },
    );
  });

  it("a sender returning something that is not a hash is refused", async () => {
    const { rpc } = scriptedRpc(HEALTHY);
    const broadcast = createPayeeRelayBroadcaster({
      rpc,
      relayerAddress: RELAYER,
      send: () => "submitted",
      gasLimitMarginPercent: 25,
    });
    await broadcast(REQUEST).then(
      () => expect.unreachable(),
      (e: RelayRefusal) => expect(e.reason).toBe("send_returned_no_hash"),
    );
  });

  it("a node that will not say what time it is refuses without sending", async () => {
    for (const broken of [
      { error: { code: -32016, message: "over rate limit" } },
      null,
      "0x1",
      { number: "0x2fe1de0" },
      { number: "0x2fe1de0", timestamp: "not-hex" },
    ]) {
      const { rpc } = scriptedRpc({ ...HEALTHY, eth_getBlockByNumber: broken });
      const send = countingSend();
      const broadcast = createPayeeRelayBroadcaster({
        rpc,
        relayerAddress: RELAYER,
        send: send.send,
        gasLimitMarginPercent: 25,
      });
      await broadcast(REQUEST).then(
        () => expect.unreachable("an unreadable chain clock must not be sent past"),
        (e: RelayRefusal) => expect(e.reason, JSON.stringify(broken)).toBe("chain_time_unavailable"),
      );
      expect(send.calls.length).toBe(0);
    }
  });

  it("a simulation would PASS on the transaction the window floor refuses", async () => {
    const lateHead = VALID_BEFORE - 20;
    const { rpc } = scriptedRpc({
      ...HEALTHY,
      eth_getBlockByNumber: { number: "0x2fe1de0", timestamp: `0x${lateHead.toString(16)}` },
    });
    const sim = await simulateTransaction({ rpc, request: REQUEST, from: RELAYER });
    expect(sim.kind, "the simulation must be the thing that says YES here").toBe("would_succeed");

    const send = countingSend();
    const broadcast = createPayeeRelayBroadcaster({
      rpc,
      relayerAddress: RELAYER,
      send: send.send,
      gasLimitMarginPercent: 25,
    });
    await broadcast(REQUEST).then(
      () => expect.unreachable("a relay too late to confirm in must not be sent"),
      (e: RelayRefusal) => {
        expect(e.reason).toBe("relay_window_too_short");
        expect(e.message).toContain("20000 ms of window remain");
        expect(e.message).toContain("redeemGrant answers `expired`");
      },
    );
    expect(send.calls.length, "the payment reached the wire").toBe(0);
  });

  it("SAME-RUN CONTROL: one millisecond more window and the identical bytes send", async () => {
    const floorSeconds = MIN_GRANT_TTL_MS / 1000;

    const tooLate = VALID_BEFORE - floorSeconds + 1;
    const exactly = VALID_BEFORE - floorSeconds;

    const at = (headSeconds: number) => {
      const { rpc } = scriptedRpc({
        ...HEALTHY,
        eth_getBlockByNumber: { number: "0x2fe1de0", timestamp: `0x${headSeconds.toString(16)}` },
      });
      const send = countingSend();
      return {
        send,
        broadcast: createPayeeRelayBroadcaster({
          rpc,
          relayerAddress: RELAYER,
          send: send.send,
          gasLimitMarginPercent: 25,
        }),
      };
    };

    const late = at(tooLate);
    await late.broadcast(REQUEST).then(
      () => expect.unreachable("one second under the rail's floor must not send"),
      (e: RelayRefusal) => expect(e.reason).toBe("relay_window_too_short"),
    );
    expect(late.send.calls.length).toBe(0);

    const ok = at(exactly);
    expect(await ok.broadcast(REQUEST)).toBe(TX_HASH);
    expect(ok.send.calls.length).toBe(1);
  });

  it("the floor is the RAIL's number, and it is read rather than restated", () => {
    const head = BigInt(VALID_BEFORE) - BigInt(MIN_GRANT_TTL_MS / 1000);
    expect(
      checkRelayRemainingWindow({ data: REQUEST.data, chainHeadSeconds: head }).ok,
      "exactly MIN_GRANT_TTL_MS must pass",
    ).toBe(true);
    expect(
      checkRelayRemainingWindow({ data: REQUEST.data, chainHeadSeconds: head + BigInt(1) }).ok,
      "one second under MIN_GRANT_TTL_MS must fail",
    ).toBe(false);

    const past = checkRelayRemainingWindow({
      data: REQUEST.data,
      chainHeadSeconds: BigInt(VALID_BEFORE + 10),
    });
    expect(past.ok).toBe(false);
    expect(past.remainingMs).toBe(BigInt(-10_000));

    expect(
      checkRelayRemainingWindow({ data: "0xdeadbeef", chainHeadSeconds: BigInt(0) }).ok,
    ).toBe(false);
  });

  it("a malformed relayer address throws at construction, not at spend time", () => {
    const { rpc } = scriptedRpc(HEALTHY);
    expect(() =>
      createPayeeRelayBroadcaster({
        rpc,
        relayerAddress: "not-an-address",
        send: () => TX_HASH,
        gasLimitMarginPercent: 25,
      }),
    ).toThrow(/relayerAddress/);
  });
});

describe("createSelfSubmitter over the payee relay", () => {
  const signed = {
    typedData: {
      domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: USDC },
      types: { EIP712Domain: [], TransferWithAuthorization: [] },
      primaryType: "TransferWithAuthorization",
      message: {
        from: "0x5cad296e06a976886a5d5bef831520c3d5965af0",
        to: RELAYER,
        value: "1000000",
        validAfter: "0",
        validBefore: "1900000000",
        nonce: `0x${"ab".repeat(32)}`,
      },
    },
    signature: `0x${"11".repeat(65)}`,
    v: 27,
    r: `0x${"11".repeat(32)}`,
    s: `0x${"22".repeat(32)}`,
    chain: "eip155:8453",
    grantHash: "c3".repeat(32),
  } as unknown as SignedTransferAuthorization;

  it("a good relay yields a transaction hash the provider can present", async () => {
    const { rpc } = scriptedRpc(HEALTHY);
    const send = countingSend();
    const submitter = createSelfSubmitter({
      broadcast: createPayeeRelayBroadcaster({
        rpc,
        relayerAddress: RELAYER,
        send: send.send,
        gasLimitMarginPercent: 25,
      }),
    });
    const out = await submitter.submit(signed);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.transactionHash).toBe(TX_HASH);
  });

  it("a relay refusal arrives as `broadcast_failed` carrying the revert reason", async () => {
    const { rpc } = scriptedRpc({
      ...HEALTHY,
      eth_call: {
        error: { code: 3, message: "execution reverted", data: errorString("FiatTokenV2: invalid signature") },
      },
    });
    const send = countingSend();
    const submitter = createSelfSubmitter({
      broadcast: createPayeeRelayBroadcaster({
        rpc,
        relayerAddress: RELAYER,
        send: send.send,
        gasLimitMarginPercent: 25,
      }),
    });
    const out = await submitter.submit(signed);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("broadcast_failed");
    expect(out.detail).toContain("FiatTokenV2: invalid signature");
    expect(send.calls.length).toBe(0);
  });
});

describe("relays from one address never overlap", () => {
  function overlapDetectingSend(delayMs = 4) {
    let inFlight = 0;
    let maxInFlight = 0;
    let started = 0;
    const order: number[] = [];
    return {
      get maxInFlight() {
        return maxInFlight;
      },
      get started() {
        return started;
      },
      order,
      send: async () => {
        const mine = started++;
        inFlight += 1;
        if (inFlight > maxInFlight) maxInFlight = inFlight;
        await new Promise((r) => setTimeout(r, delayMs));
        order.push(mine);
        inFlight -= 1;
        return TX_HASH;
      },
    };
  }

  it("twenty concurrent relays run strictly one at a time, and all twenty land", async () => {
    const send = overlapDetectingSend();
    const broadcast = createPayeeRelayBroadcaster({
      rpc: scriptedRpc(HEALTHY).rpc,
      relayerAddress: RELAYER,
      send: send.send,
      gasLimitMarginPercent: 25,
    });

    const hashes = await Promise.all(Array.from({ length: 20 }, () => broadcast(REQUEST)));

    expect(send.maxInFlight, "relays overlapped — the transaction nonce will collide").toBe(1);
    expect(hashes.length).toBe(20);
    expect(hashes.every((h) => h === TX_HASH)).toBe(true);
    expect(send.started).toBe(20);
    expect(send.order.length).toBe(20);
  });

  it("a relay that throws does not poison the queue behind it", async () => {
    let call = 0;
    const broadcast = createPayeeRelayBroadcaster({
      rpc: scriptedRpc(HEALTHY).rpc,
      relayerAddress: RELAYER,
      send: async () => {
        const mine = call++;
        await new Promise((r) => setTimeout(r, 2));
        if (mine === 0) throw new Error("node rejected it");
        return TX_HASH;
      },
      gasLimitMarginPercent: 25,
    });

    const results = await Promise.allSettled([
      broadcast(REQUEST),
      broadcast(REQUEST),
      broadcast(REQUEST),
    ]);
    expect(results[0].status).toBe("rejected");
    expect(results[1].status).toBe("fulfilled");
    expect(results[2].status).toBe("fulfilled");
  });

  it("different relayer addresses do NOT contend with each other", async () => {
    const send = overlapDetectingSend(6);
    const mk = (addr: string) =>
      createPayeeRelayBroadcaster({
        rpc: scriptedRpc(HEALTHY).rpc,
        relayerAddress: addr,
        send: send.send,
        gasLimitMarginPercent: 25,
      });
    await Promise.all([
      mk(RELAYER)(REQUEST),
      mk("0x5cad296e06a976886a5d5bef831520c3d5965af0")(REQUEST),
    ]);
    expect(send.maxInFlight, "two different relayers were serialised against each other").toBe(2);
  });
});

const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";

const SIGNED = {
  typedData: {
    domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: USDC },
    types: { EIP712Domain: [], TransferWithAuthorization: [] },
    primaryType: "TransferWithAuthorization",
    message: {
      from: "0x5cad296e06a976886a5d5bef831520c3d5965af0",
      to: RELAYER,
      value: "1000000",
      validAfter: "0",
      validBefore: "1900000000",
      nonce: `0x${"ab".repeat(32)}`,
    },
  },
  signature: `0x${"11".repeat(65)}`,
  v: 27,
  r: `0x${"11".repeat(32)}`,
  s: `0x${"22".repeat(32)}`,
  chain: "eip155:8453",
  grantHash: "c3".repeat(32),
} as unknown as SignedTransferAuthorization;

const RECEIVE_SIGNED = {
  ...SIGNED,
  typedData: {
    ...(SIGNED as unknown as { typedData: Record<string, unknown> }).typedData,
    types: { EIP712Domain: [], ReceiveWithAuthorization: [] },
    primaryType: "ReceiveWithAuthorization",
  },
} as unknown as SignedReceiveAuthorization;

describe("a batched relay is refused before any I/O", () => {
  function rig() {
    const { rpc, asked } = scriptedRpc(HEALTHY);
    const send = countingSend();
    return {
      asked,
      send,
      broadcast: createPayeeRelayBroadcaster({
        rpc,
        relayerAddress: RELAYER,
        send: send.send,
        gasLimitMarginPercent: 25,
      }),
    };
  }

  it("POSITIVE CONTROL: the one admitted shape passes, and this module's own builder produces it", () => {
    expect(checkSingleAuthorizationRelay(REQUEST)).toEqual({ ok: true });

    const built = buildTransferWithAuthorizationCalldata(SIGNED);
    expect(built.ok, built.ok ? "" : built.detail).toBe(true);
    if (!built.ok) return;
    expect(checkSingleAuthorizationRelay(built.request)).toEqual({ ok: true });
  });

  it("a multicall destination is refused, and the node is never asked", async () => {
    const r = rig();
    await r.broadcast({ ...REQUEST, to: MULTICALL3 }).then(
      () => expect.unreachable("a batched relay must not be sent"),
      (e: RelayRefusal) => {
        expect(e.reason).toBe("batched_relay_refused");
        expect(e.message).toContain(MULTICALL3);
        expect(e.message).toContain("intermediary");
        expect(e.message).toContain("no provider in the batch can redeem");
      },
    );
    expect(r.send.calls.length, "a batch reached the sender").toBe(0);
    expect(r.asked, "a batch cost an RPC round trip before being refused").toEqual([]);
  });

  it("a second authorization appended to well-formed calldata is refused", async () => {
    const r = rig();
    const piggybacked = `${REQUEST.data}${"11".repeat(288)}`;
    await r.broadcast({ ...REQUEST, data: piggybacked }).then(
      () => expect.unreachable("surplus calldata must not be sent"),
      (e: RelayRefusal) => {
        expect(e.reason).toBe("batched_relay_refused");
        expect(e.message).toContain("584");
        expect(e.message).toContain("rides along");
      },
    );
    expect(r.send.calls.length).toBe(0);
    expect(r.asked).toEqual([]);
    expect(checkSingleAuthorizationRelay({ ...REQUEST, data: REQUEST.data.slice(0, -2) }).ok).toBe(
      false,
    );
  });

  it("any selector outside the two VERIFIED entry points is refused", async () => {
    const r = rig();
    for (const selector of [
      "0xcf092995",
      "0x252598f0",
      "0xa9059cbb",
      "0xdeadbeef",
    ]) {
      const data = `${selector}${REQUEST.data.slice(10)}`;
      const check = checkSingleAuthorizationRelay({ ...REQUEST, data });
      expect(check.ok, selector).toBe(false);
      if (check.ok) continue;
      expect(check.detail).toContain(selector);
    }
    await r.broadcast({ ...REQUEST, data: `0xa9059cbb${REQUEST.data.slice(10)}` }).catch(
      (e: RelayRefusal) => expect(e.reason).toBe("batched_relay_refused"),
    );
    expect(r.send.calls.length).toBe(0);
  });

  const RECEIVE_REQUEST: TransactionRequest = Object.freeze({
    ...REQUEST,
    data: eip3009Calldata({ selector: RECEIVE_WITH_AUTHORIZATION_SELECTOR, to: RELAYER }),
  });

  it("the receive variant is admitted, and its calldata is this package's own", () => {
    expect(RECEIVE_REQUEST.data.length - 2, "the fixture itself must be 584").toBe(584);
    expect(checkSingleAuthorizationRelay(RECEIVE_REQUEST)).toEqual({ ok: true });

    const built = buildReceiveWithAuthorizationCalldata(RECEIVE_SIGNED);
    expect(built.ok, built.ok ? "" : built.detail).toBe(true);
    if (!built.ok) return;
    expect(built.request.data.slice(0, 10)).toBe(RECEIVE_WITH_AUTHORIZATION_SELECTOR);
    expect(built.request.data.length - 2).toBe(584);
    expect(checkSingleAuthorizationRelay(built.request)).toEqual({ ok: true });
    expect(checkSingleAuthorizationRelay(built.request, { relayerAddress: RELAYER })).toEqual({
      ok: true,
    });
  });

  it("the transfer and receive encodings differ in the selector and NOTHING else", () => {
    const t = buildTransferWithAuthorizationCalldata(SIGNED);
    const rcv = buildReceiveWithAuthorizationCalldata(RECEIVE_SIGNED);
    expect(t.ok && rcv.ok).toBe(true);
    if (!t.ok || !rcv.ok) return;
    expect(rcv.request.data.slice(10)).toBe(t.request.data.slice(10));
    expect(rcv.request.data.slice(0, 10)).not.toBe(t.request.data.slice(0, 10));
    expect(rcv.request.to).toBe(t.request.to);
    expect(rcv.request.value).toBe("0x0");
    expect(rcv.request.chainId).toBe(t.request.chainId);
  });

  it("EVERY OTHER ARM still bites on receive calldata", async () => {
    expect(checkSingleAuthorizationRelay({ ...RECEIVE_REQUEST, to: MULTICALL3 }).ok).toBe(false);
    expect(
      checkSingleAuthorizationRelay({
        ...RECEIVE_REQUEST,
        data: `${RECEIVE_REQUEST.data}${"11".repeat(288)}`,
      }).ok,
    ).toBe(false);
    expect(
      checkSingleAuthorizationRelay({
        ...RECEIVE_REQUEST,
        data: RECEIVE_REQUEST.data.slice(0, -2),
      }).ok,
    ).toBe(false);
    expect(checkSingleAuthorizationRelay({ ...RECEIVE_REQUEST, value: "0x1" as "0x0" }).ok).toBe(
      false,
    );
    expect(checkSingleAuthorizationRelay({ ...RECEIVE_REQUEST, chainId: 1 }).ok).toBe(false);

    const r = rig();
    await r.broadcast({ ...RECEIVE_REQUEST, to: MULTICALL3 }).then(
      () => expect.unreachable("a batched receive relay must not be sent"),
      (e: RelayRefusal) => expect(e.reason).toBe("batched_relay_refused"),
    );
    expect(r.send.calls.length).toBe(0);
    expect(r.asked).toEqual([]);
  });

  it("a receive call naming someone else as payee is refused offline, not at a node", async () => {
    const stranger = "0x00000000000000000000000000000000deadbee1";
    const notMine = eip3009Calldata({
      selector: RECEIVE_WITH_AUTHORIZATION_SELECTOR,
      to: stranger,
    });
    const check = checkSingleAuthorizationRelay(
      { ...RECEIVE_REQUEST, data: notMine },
      { relayerAddress: RELAYER },
    );
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.detail).toContain("msg.sender == to");

    expect(checkSingleAuthorizationRelay({ ...RECEIVE_REQUEST, data: notMine })).toEqual({
      ok: true,
    });

    expect(checkSingleAuthorizationRelay(REQUEST, { relayerAddress: RELAYER })).toEqual({
      ok: true,
    });
    expect(checkSingleAuthorizationRelay(REQUEST, { relayerAddress: stranger })).toEqual({
      ok: true,
    });

    const r = rig();
    await r.broadcast({ ...RECEIVE_REQUEST, data: notMine }).then(
      () => expect.unreachable("a receive relay this relayer cannot make must not be sent"),
      (e: RelayRefusal) => expect(e.reason).toBe("batched_relay_refused"),
    );
    expect(r.send.calls.length).toBe(0);
    expect(r.asked).toEqual([]);
  });

  it("an unreadable relayerAddress refuses rather than skipping the arm", () => {
    for (const bad of ["", "0x", "not-an-address", `0x${"ff".repeat(21)}`]) {
      expect(checkSingleAuthorizationRelay(RECEIVE_REQUEST, { relayerAddress: bad }).ok, bad).toBe(
        false,
      );
    }
  });

  it("a chain with no frozen USDC deployment is refused rather than waved through", async () => {
    for (const chainId of [1, 137, 42161, 0, -1, 1.5]) {
      const check = checkSingleAuthorizationRelay({ ...REQUEST, chainId });
      expect(check.ok, `chainId=${chainId}`).toBe(false);
    }
    const r = rig();
    await r.broadcast({ ...REQUEST, chainId: 1 }).then(
      () => expect.unreachable("an uncheckable chain must not be sent"),
      (e: RelayRefusal) => expect(e.reason).toBe("batched_relay_refused"),
    );
    expect(r.send.calls.length).toBe(0);
    expect(r.asked, "the chain-id RPC ran before the batch check").toEqual([]);
  });

  it("native value alongside the call is refused — that is a transaction doing two things", () => {
    for (const value of ["0x1", "0xde0b6b3a7640000", "", undefined, null]) {
      expect(
        checkSingleAuthorizationRelay({ ...REQUEST, value: value as "0x0" }).ok,
        `value=${String(value)}`,
      ).toBe(false);
    }
  });

  it("the destination comparison is case-insensitive — the refusal is not about spelling", () => {
    const checksummed = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
    expect(checkSingleAuthorizationRelay({ ...REQUEST, to: checksummed })).toEqual({ ok: true });
    expect(checkSingleAuthorizationRelay({ ...REQUEST, to: `${USDC.slice(0, -1)}4` }).ok).toBe(
      false,
    );
  });
});

describe("the EIP-3009 constants are measurements, not memories", () => {
  it("the two selectors are the keccak prefixes of their signatures", () => {
    expect(TRANSFER_WITH_AUTHORIZATION_SELECTOR).toBe(
      keccakUtf8(
        "transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)",
      ).slice(0, 10),
    );
    expect(RECEIVE_WITH_AUTHORIZATION_SELECTOR).toBe(
      keccakUtf8(
        "receiveWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)",
      ).slice(0, 10),
    );
    expect(RECEIVE_WITH_AUTHORIZATION_SELECTOR).not.toBe(TRANSFER_WITH_AUTHORIZATION_SELECTOR);
  });

  it("AUTHORIZATION_USED_TOPIC0 is the keccak of the event signature", () => {
    expect(AUTHORIZATION_USED_TOPIC0).toBe(keccakUtf8("AuthorizationUsed(address,bytes32)"));
  });
});

describe("resolveSettlementTransaction answers `did my authorization land`", () => {
  const AUTHORIZER = "0x5cad296e06a976886a5d5bef831520c3d5965af0";
  const BINDING = "ab".repeat(32);
  const WINNER = `0x${"3c".repeat(32)}`;

  const OK_INPUT = {
    chainId: 8453,
    authorizer: AUTHORIZER,
    bindingReference: BINDING,
    fromBlock: BigInt(1000),
  };

  function logsRpc(result: unknown) {
    const asked: Array<{ method: string; params: unknown }> = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { method: string; params: unknown; id: number };
      asked.push({ method: body.method, params: body.params });
      const payload =
        result && typeof result === "object" && "error" in (result as object)
          ? { jsonrpc: "2.0", id: body.id, error: (result as { error: unknown }).error }
          : { jsonrpc: "2.0", id: body.id, result };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    return {
      asked,
      rpc: createReadOnlyEvmRpc({ url: "https://rpc.example.test", fetchImpl: fetchImpl as never }),
    };
  }

  const oneLog = [
    {
      address: USDC,
      topics: [AUTHORIZATION_USED_TOPIC0, `0x${"0".repeat(24)}${AUTHORIZER.slice(2)}`, `0x${BINDING}`],
      transactionHash: WINNER,
      blockNumber: "0x4d3",
    },
  ];

  it("finds the one transaction that spent (authorizer, nonce)", async () => {
    const { rpc, asked } = logsRpc(oneLog);
    const r = await resolveSettlementTransaction({ rpc, ...OK_INPUT });
    expect(r.kind).toBe("found");
    if (r.kind !== "found") return;
    expect(r.transactionHash).toBe(WINNER);
    expect(r.blockNumber).toBe(BigInt(0x4d3));

    expect(asked.length).toBe(1);
    expect(asked[0].method).toBe("eth_getLogs");
    const filter = (asked[0].params as Array<Record<string, unknown>>)[0];
    expect(filter.address).toBe(USDC);
    expect(filter.topics).toEqual([
      AUTHORIZATION_USED_TOPIC0,
      `0x${"0".repeat(24)}${AUTHORIZER.slice(2)}`,
      `0x${BINDING}`,
    ]);
    expect(filter.fromBlock).toBe("0x3e8");
    expect(filter.toBlock).toBe("latest");
  });

  it("accepts the binding reference with or without an 0x, and lowercases", async () => {
    for (const ref of [BINDING, `0x${BINDING}`, BINDING.toUpperCase()]) {
      const { rpc } = logsRpc(oneLog);
      const r = await resolveSettlementTransaction({ ...OK_INPUT, rpc, bindingReference: ref });
      expect(r.kind, ref).toBe("found");
    }
  });

  it("zero logs is `not_consumed`, and says nothing about cancellation", async () => {
    const { rpc } = logsRpc([]);
    const r = await resolveSettlementTransaction({ rpc, ...OK_INPUT });
    expect(r.kind).toBe("not_consumed");
  });

  it("MORE THAN ONE is `impossible`, never a choice", async () => {
    const { rpc } = logsRpc([oneLog[0], { ...oneLog[0], transactionHash: `0x${"9e".repeat(32)}` }]);
    const r = await resolveSettlementTransaction({ rpc, ...OK_INPUT });
    expect(r.kind).toBe("impossible");
    if (r.kind !== "impossible") return;
    expect(r.detail).toContain("at most one");
  });

  it("a node that refuses the range is `unavailable`, never `not_consumed`", async () => {
    const { rpc } = logsRpc({ error: { code: -32005, message: "query exceeds max block range" } });
    const r = await resolveSettlementTransaction({ rpc, ...OK_INPUT });
    expect(r.kind).toBe("unavailable");
    if (r.kind !== "unavailable") return;
    expect(r.detail).toContain("query exceeds max block range");
  });

  it("`fromBlock` is REQUIRED and never defaulted", async () => {
    const { rpc, asked } = logsRpc(oneLog);
    for (const bad of [undefined, null, 1000, "0x3e8", BigInt(-1)]) {
      const r = await resolveSettlementTransaction({
        rpc,
        ...OK_INPUT,
        fromBlock: bad as unknown as bigint,
      });
      expect(r.kind, String(bad)).toBe("unavailable");
    }
    expect(asked, "a malformed anchor still reached the node").toEqual([]);
  });

  it("refuses a chain with no frozen deployment rather than querying every contract", async () => {
    const { rpc, asked } = logsRpc(oneLog);
    const r = await resolveSettlementTransaction({ rpc, ...OK_INPUT, chainId: 1 });
    expect(r.kind).toBe("unavailable");
    expect(asked).toEqual([]);
  });

  it("refuses a malformed authorizer or binding reference before any I/O", async () => {
    const { rpc, asked } = logsRpc(oneLog);
    for (const authorizer of ["", "0x", "nope", `0x${"11".repeat(21)}`]) {
      expect(
        (await resolveSettlementTransaction({ rpc, ...OK_INPUT, authorizer })).kind,
        authorizer,
      ).toBe("unavailable");
    }
    for (const bindingReference of ["", "0x", "abc", "zz".repeat(32)]) {
      expect(
        (await resolveSettlementTransaction({ rpc, ...OK_INPUT, bindingReference })).kind,
        bindingReference,
      ).toBe("unavailable");
    }
    expect(asked).toEqual([]);
  });

  it("a pending log — no block number — is not a payment yet", async () => {
    const { rpc } = logsRpc([{ ...oneLog[0], blockNumber: null }]);
    const r = await resolveSettlementTransaction({ rpc, ...OK_INPUT });
    expect(r.kind).toBe("unavailable");
  });

  it("a log with an unreadable transactionHash is `unavailable`, not `found`", async () => {
    const { rpc } = logsRpc([{ ...oneLog[0], transactionHash: "0xnope" }]);
    const r = await resolveSettlementTransaction({ rpc, ...OK_INPUT });
    expect(r.kind).toBe("unavailable");
  });

  it("eth_getLogs is allowlisted, and the write methods still are not", () => {
    expect(READ_ONLY_RPC_METHODS).toContain("eth_getLogs");
    for (const m of FORBIDDEN_RPC_METHODS) expect(READ_ONLY_RPC_METHODS).not.toContain(m);
  });
});
