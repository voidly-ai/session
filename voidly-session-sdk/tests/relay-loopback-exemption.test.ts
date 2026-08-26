
import { describe, expect, it } from "vitest";

import { createReadOnlyEvmRpc } from "../src/index";

function spy() {
  const urls: string[] = [];
  const fetchImpl = (async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x2105" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as never;
  return { urls, fetchImpl };
}

async function ask(url: string, method = "eth_chainId") {
  const { urls, fetchImpl } = spy();
  const res = await createReadOnlyEvmRpc({ url, fetchImpl }).request(method, []);
  return { res, urls };
}

describe("ADMITTED: https anywhere, http to a literal loopback address", () => {
  it("https to a public node is unchanged", async () => {
    const { res, urls } = await ask("https://mainnet.base.org");
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(urls).toHaveLength(1);
  });

  it("http to 127.0.0.1 reaches the fetch — the loopback exemption", async () => {
    const { res, urls } = await ask("http://127.0.0.1:8545");
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(urls[0]).toBe("http://127.0.0.1:8545/");
  });

  it("http to [::1] — the same host, spelled v6", async () => {
    const { res, urls } = await ask("http://[::1]:8545");
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(urls[0]).toContain("[::1]");
  });

  it("the whole of 127.0.0.0/8, not just .0.0.1", async () => {
    for (const host of ["127.0.0.2", "127.1.2.3", "127.255.255.254"]) {
      const { res } = await ask(`http://${host}:8545`);
      expect(res.ok, `${host}: ${JSON.stringify(res)}`).toBe(true);
    }
  });

  it("obfuscated loopback spellings are admitted AS loopback, because the parser normalises them", async () => {
    for (const spelling of ["http://0x7f000001/", "http://2130706433/", "http://127.1/"]) {
      const { res, urls } = await ask(spelling);
      expect(res.ok, `${spelling}: ${JSON.stringify(res)}`).toBe(true);
      expect(urls[0], spelling).toBe("http://127.0.0.1/");
    }
  });
});

describe("STILL REFUSED: everything routable, and everything that only looks local", () => {
  async function refused(url: string) {
    const { res, urls } = await ask(url);
    expect(res.ok, `${url} was ADMITTED — the exemption has widened`).toBe(false);
    if (res.ok) return;
    expect(res.reason, url).toBe("rpc_url_not_https");
    expect(urls, `${url} was refused only AFTER reaching the network`).toHaveLength(0);
  }

  it("a routable http host — the original arm, and it must never go green", async () => {
    await refused("http://rpc.example.test");
  });

  it("a private-range http host is NOT loopback", async () => {
    for (const host of ["10.0.0.5", "192.168.1.10", "172.16.0.9"]) await refused(`http://${host}:8545`);
  });

  it("`localhost` is a NAME and is refused — deliberately, not by oversight", async () => {
    await refused("http://localhost:8545");
    await refused("http://localhost.");
  });

  it("userinfo cannot smuggle a loopback host past the check", async () => {
    await refused("http://127.0.0.1@evil.com/");
    await refused("http://127.0.0.1:8545@evil.com/");
  });

  it("a hostname that merely starts with a loopback literal is a hostname", async () => {
    await refused("http://127.0.0.1.evil.com/");
    await refused("http://127.0.0.1-evil.example/");
  });

  it("an IPv4-mapped v6 loopback is refused — the allowlist is two shapes, not every equivalent", async () => {
    await refused("http://[::ffff:127.0.0.1]/");
  });

  it("other schemes are refused, loopback or not", async () => {
    await refused("ws://127.0.0.1:8545");
    await refused("file:///etc/passwd");
  });
});

describe("the exemption widens what may be READ, never what may be DONE", () => {
  it("refuses a write method to loopback, before any I/O", async () => {
    const { res, urls } = await ask("http://127.0.0.1:8545", "eth_sendRawTransaction");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("rpc_method_not_read_only");
    expect(urls).toHaveLength(0);
  });

  it("POSITIVE CONTROL: the spy would have recorded a fetch if one happened", async () => {
    const { urls } = await ask("http://127.0.0.1:8545");
    expect(urls).toHaveLength(1);
  });
});
