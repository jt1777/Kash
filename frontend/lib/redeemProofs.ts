import type { PublicClient } from 'viem';
import { buildClaimProofFromChain } from '@/lib/redeemClaimAmount';

export type RedeemProofManifest = {
  batchCycle: string;
  root: string;
  leaves: Array<{ user: string; amount: string; proof: string[] }>;
};

export function formatClaimPayoutAmount(
  product: 'eth' | 'btc',
  amountWei: bigint,
): string {
  if (product === 'btc') {
    const n = Number(amountWei) / 1e8;
    return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 8 });
  }
  const n = Number(amountWei) / 1e18;
  return n.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 6 });
}

async function fetchRedeemProofManifest(
  product: 'eth' | 'btc',
  batchCycle: bigint,
): Promise<RedeemProofManifest | null> {
  const file = `${product}-batch-${batchCycle.toString()}.json`;
  const urls: string[] = [];
  const base = process.env.NEXT_PUBLIC_REDEEM_PROOF_BASE_URL?.replace(/\/+$/, '');
  if (base) urls.push(`${base}/${file}`);
  urls.push(`/redeem-proofs/${file}`);

  for (const url of urls) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (res.ok) return (await res.json()) as RedeemProofManifest;
    } catch {
      // try next source
    }
  }
  return null;
}

export async function fetchRedeemProof(
  product: 'eth' | 'btc',
  batchCycle: bigint,
  userAddress: string,
): Promise<{ amount: bigint; proof: `0x${string}`[] } | null> {
  const manifest = await fetchRedeemProofManifest(product, batchCycle);
  if (!manifest) return null;
  const leaf = manifest.leaves.find(
    (l) => l.user.toLowerCase() === userAddress.toLowerCase(),
  );
  if (!leaf) return null;
  return {
    amount: BigInt(leaf.amount),
    proof: leaf.proof as `0x${string}`[],
  };
}

/** Hosted proof JSON when available; otherwise rebuild from on-chain batch data. */
export async function resolveClaimProof(
  options: {
    product: 'eth' | 'btc';
    batchCycle: bigint;
    userAddress: `0x${string}`;
    kashYield?: `0x${string}`;
    publicClient?: PublicClient | null;
  },
): Promise<{ amount: bigint; proof: `0x${string}`[] } | null> {
  const { product, batchCycle, userAddress, kashYield, publicClient } = options;
  const hosted = await fetchRedeemProof(product, batchCycle, userAddress);
  if (hosted) return hosted;
  if (publicClient && kashYield) {
    return buildClaimProofFromChain(publicClient, kashYield, batchCycle, userAddress);
  }
  return null;
}
