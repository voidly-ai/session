
import { Wallet } from "ethers";
import { signTransferAuthorization } from "../src/index";
import type { SignedTransferAuthorization } from "../src/index";

export const CHAIN = "eip155:8453";
export const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
export const PAYER = "0x5cad296e06a976886a5d5bef831520c3d5965af0";
export const PAYEE = "0xb0b3fca940e04f99367f08e665e1c2cb4ebd4912";
export const GRANT_HASH = "c3".repeat(32);
export const NOW_MS = 1_800_000_000_000;
export const NOW_S = Math.floor(NOW_MS / 1000);
export const TX_HASH = `0x${"7f".repeat(32)}`;

export function baseInput(over: Record<string, unknown> = {}) {
  return {
    chain: CHAIN,
    from: PAYER,
    to: PAYEE,
    value: "1000000",
    validAfter: 0,
    validBefore: NOW_S + 3600,
    grantHash: GRANT_HASH,
    nowMs: NOW_MS,
    ...over,
  } as Parameters<typeof signTransferAuthorization>[0];
}

export async function signedWithRealKey(
  over: Record<string, unknown> = {},
): Promise<{ signed: SignedTransferAuthorization; wallet: Wallet }> {
  const wallet = Wallet.createRandom();
  const input = baseInput({ from: wallet.address, ...over });
  const outcome = await signTransferAuthorization(input, (typedData) =>
    wallet.signTypedData(
      typedData.domain,
      { TransferWithAuthorization: [...typedData.types.TransferWithAuthorization] },
      typedData.message,
    ),
  );
  if (!outcome.ok) throw new Error(`fixture signature refused: ${outcome.reason}`);
  return { signed: outcome.signed, wallet: wallet as unknown as Wallet };
}
