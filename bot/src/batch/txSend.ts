import { ethers } from 'ethers';

export type TxFactory = () => Promise<ethers.ContractTransactionResponse>;

/** True when the RPC rejects a tx because its nonce was already consumed on-chain. */
export function isNonceExpiredError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as {
    code?: string;
    shortMessage?: string;
    message?: string;
    info?: { error?: { message?: string } };
  };
  if (e.code === 'NONCE_EXPIRED') return true;
  const msg = [e.shortMessage, e.info?.error?.message, e.message].filter(Boolean).join(' ');
  return /nonce too low|nonce has already been used/i.test(msg);
}

/**
 * Send a contract tx and wait for confirmation. Retries once on stale nonce after a burst of
 * sequential sends (e.g. adapter sync then KashYield ops on the same bot key).
 */
export async function execTx(
  label: string,
  sendTx: TxFactory,
): Promise<ethers.ContractTransactionReceipt> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const tx = await sendTx();
      const receipt = await tx.wait();
      if (!receipt) {
        throw new Error(`${label}: transaction dropped (no receipt)`);
      }
      console.log(`      → ${label} confirmed`);
      return receipt;
    } catch (error: unknown) {
      lastError = error;
      if (attempt === 0 && isNonceExpiredError(error)) {
        console.warn(`      ⚠️  ${label}: stale nonce, retrying once with fresh nonce...`);
        continue;
      }
      throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
