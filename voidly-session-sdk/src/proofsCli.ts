#!/usr/bin/env node
import { PUBLIC_EXERCISE_MAX_BYTES, PublicExerciseError, proofArtworkSvg, runPublicExercise, runSessionsSelfTest } from "./proofs";

async function input(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => { clearTimeout(timer); process.stdin.removeListener("data", onData); process.stdin.removeListener("end", onEnd); process.stdin.removeListener("error", onError); process.stdin.pause(); };
    const fail = () => { cleanup(); reject(new Error("input_invalid")); };
    const onData = (chunk: Buffer) => { size += chunk.byteLength; if (size > PUBLIC_EXERCISE_MAX_BYTES) fail(); else chunks.push(chunk); };
    const onEnd = () => { cleanup(); try { resolve(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); } catch { reject(new Error("input_invalid")); } };
    const onError = () => fail();
    const timer = setTimeout(fail, 30000);
    process.stdin.on("data", onData); process.stdin.once("end", onEnd); process.stdin.once("error", onError);
  });
}

async function main(): Promise<number> {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 20 || major === 20 && minor < 3) {
    process.stderr.write("This CLI requires Node.js 20.3 or newer. No check was run.\n"); return 1;
  }
  const args = process.argv.slice(2);
  if (args.length === 2 && args[0] === "artwork" && /^[0-9a-f]{32}$/.test(args[1])) {
    process.stdout.write(proofArtworkSvg(args[1]) + "\n");
    process.stderr.write("Decorative artwork only. The supplied identifier was not checked with a server.\n");
    return 0;
  }
  if (args.length !== 1 || !["self-test", "public-check", "--help"].includes(args[0])) {
    process.stderr.write("Usage: voidly-session self-test | public-check | artwork <saved-event-id> | --help\n"); return 1;
  }
  if (args[0] === "--help") {
    process.stdout.write("self-test: offline SDK verification; no network.\npublic-check: public exercise JSON on stdin; two fixed public GETs; result JSON on stdout.\nartwork <saved-event-id>: decorative SVG on stdout, generated locally; no savedness verification.\nThese commands do not save proofs, publish or perform payment. Review the installed package before running it.\n"); return 0;
  }
  try {
    if (args[0] === "self-test") {
      const result = await runSessionsSelfTest(); process.stdout.write(JSON.stringify(result, null, 2) + "\n"); return result.ok ? 0 : 3;
    }
    const result = await runPublicExercise(await input());
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    process.stderr.write("Public check complete. Import this JSON at https://voidly.ai/pay/proofs and choose Save proof. Nothing has been saved or published by this command.\n");
    return 0;
  } catch (error) {
    process.stderr.write(`Check stopped: ${error instanceof PublicExerciseError ? error.code : "check_failed"}. No proof was saved.\n`);
    return 1;
  }
}
void main().then(code => { process.exitCode = code; });
