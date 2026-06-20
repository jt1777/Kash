import type { PublicClient } from 'viem';
import { buildMintClaimProofFromChain } from '@/lib/mintClaimAmount';
import { formatEther } from 'viem';

export type MintProofManifest = {
  batchCycle: string;
  root: string;
  leaves: Array<{ user: string; amount: string; proof: string[] }>;
};

export function formatMintClaimAmount(amountWei: bigint): string {
  const n = Number(formatEther(amountWei));
  return n.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 6 });
}

async function fetchMintProofManifest(
  product: 'eth' | 'btc',
  batchCycle: bigint,
): Promise<MintProofManifest | null> {
  const file = `${product}-mint-batch-${batchCycle.toString()}.json`;
  const urls: string[] = [];
  const base = process.env.NEXT_PUBLIC_MINT_PROOF_BASE_URL?.replace(/\/+$/, '');
  if (base) urls.push(`${base}/${file}`);
  urls.push(`/mint-proofs/${file}`);

  for (const url of urls) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (res.ok) return (await res.json()) as MintProofManifest;
    } catch {
      // try next source
    }
  }
  return null;
}

export async function fetchMintProof(
  product: 'eth' | 'btc',
  batchCycle: bigint,
  userAddress: string,
): Promise<{ amount: bigint; proof: `0x${string}`[] } | null> {
  const manifest = await fetchMintProofManifest(product, batchCycle);
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

export async function resolveMintClaimProof(
  options: {
    product: 'eth' | 'btc';
    batchCycle: bigint;
    userAddress: `0x${string}`;
    kashYield?: `0x${string}`;
    publicClient?: PublicClient | null;
  },
): Promise<{ amount: bigint; proof: `0x${string}`[] } | null> {
  const { product, batchCycle, userAddress, kashYield, publicClient } = options;
  const hosted = await fetchMintProof(product, batchCycle, userAddress);
  if (hosted) return hosted;
  if (publicClient && kashYield) {
    return buildMintClaimProofFromChain(publicClient, kashYield, batchCycle, userAddress);
  }
  return null;
}
