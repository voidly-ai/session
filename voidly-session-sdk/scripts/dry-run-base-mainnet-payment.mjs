
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const out = mkdtempSync(join(tmpdir(), "voidly-dryrun-"));
const bundle = join(out, "main.mjs");

await build({
  entryPoints: [join(here, "dryRunBaseMainnetPayment.ts")],
  outfile: bundle,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});

process.env.VOIDLY_DRYRUN_AUTOSTART = "1";
try {
  await import(pathToFileURL(bundle).href);
} finally {
  process.on("exit", () => rmSync(out, { recursive: true, force: true }));
}
