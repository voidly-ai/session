import { proofArtworkSvg } from "./proofs";

export type ProofArtifactExport = {
  readonly ok: boolean;
  readonly artwork_path: string | null;
  readonly receipt_path: string | null;
  readonly error: "local_export_failed" | null;
};

export async function exportProofArtifacts(eventId: string, verifiedReceipt: unknown): Promise<ProofArtifactExport> {
  let artworkPath: string | null = null;
  let receiptPath: string | null = null;
  try {
    if (!/^[0-9a-f]{32}$/.test(eventId)) throw new Error("event_invalid");
    const svg = proofArtworkSvg(eventId);
    const receipt = JSON.stringify(verifiedReceipt, null, 2) + "\n";
    const fs = await import("node:fs/promises");
    const { constants } = await import("node:fs");
    const { join } = await import("node:path");
    if (!Number.isInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW === 0) throw new Error("no_follow_unavailable");
    const directory = await fs.mkdtemp(join(process.cwd(), "voidpay-proof-"));
    await fs.chmod(directory, 0o700);
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("directory_invalid");
    const create = async (name: string, bytes: string): Promise<string> => {
      const path = join(directory, name);
      const handle = await fs.open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(bytes, "utf8"); await handle.sync(); }
      finally { await handle.close(); }
      return path;
    };
    receiptPath = await create("proof-receipt.json", receipt);
    artworkPath = await create("proof-artwork.svg", svg);
    return { ok: true, artwork_path: artworkPath, receipt_path: receiptPath, error: null };
  } catch {
    return { ok: false, artwork_path: artworkPath, receipt_path: receiptPath, error: "local_export_failed" };
  }
}
