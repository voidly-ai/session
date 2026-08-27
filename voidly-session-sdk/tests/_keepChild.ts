
import * as fs from "node:fs";

import { openTaskResult } from "../src/hirer";
import { destroySessionKey } from "../src/index";
import { loadSessionKeep } from "../src/keep";

const [, , dir, grantHash, fixturePath] = process.argv;

function say(v: unknown): never {
  process.stdout.write(`${JSON.stringify(v)}\n`);
  process.exit(0);
}

async function main(): Promise<void> {
  if (!dir || !grantHash || !fixturePath) {
    say({ kind: "bad_argv", pid: process.pid });
  }

  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf-8")) as {
    resultCapsule: unknown;
    resultCommitment: string;
  };

  const loaded = await loadSessionKeep({ fs, dir, grantHash });
  if (!loaded.ok) {
    say({ kind: "load_refused", reason: loaded.reason, pid: process.pid });
  }

  const opened = await openTaskResult({
    resultCapsule: fixture.resultCapsule,
    sessionKey: loaded.keep.sessionKey,
    grantHash: loaded.keep.grantHash,
    resultCommitment: fixture.resultCommitment,
  });

  destroySessionKey(loaded.keep.sessionKey);

  if (opened.kind !== "opened") {
    say({ kind: "unopenable", pid: process.pid });
  }
  say({
    kind: "opened",
    result: opened.result,
    endpoint_base_url: loaded.keep.endpointBaseUrl,
    grant_hash: loaded.keep.grantHash,
    offer_signature_base64: loaded.keep.wire.offer_signature_base64,
    pid: process.pid,
  });
}

void main().catch((e: unknown) => {
  say({ kind: "threw", message: e instanceof Error ? e.message : String(e), pid: process.pid });
});
