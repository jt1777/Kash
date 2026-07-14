import type { PublicClient } from 'viem';
import { buildMintClaimProofFromChain } from '@/lib/mintClaimAmount';
import { formatEther } from 'viem';

export type MintProofManifest = {
  batchCycle: string;
  root: string;
  leaves: Array<{
    user: string;
    /** Bot manifest field */
    kashAmount?: string;
    /** Legacy / alternate field */
    amount?: string;
    proof: string[];
  }>;
};

function leafKashAmount(leaf: MintProofManifest['leaves'][number]): bigint | null {
  const raw = leaf.kashAmount ?? leaf.amount;
  if (raw == null || raw === '') return null;
  try {
    const n = BigInt(raw);
    return n > 0n ? n : null;
  } catch {
    return null;
  }
}

export function formatMintClaimAmount(amountWei: bigint): string {
  const n = Number(formatEther(amountWei));
  return n.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 6 });
}

function manifestCacheKey(product: 'eth' | 'btc', batchCycle: bigint): string {
  return `${product}:${batchCycle.toString()}`;
}

const mintManifestCache = new Map<string, MintProofManifest>();
const mintManifestInflight = new Map<string, Promise<MintProofManifest | null>>();

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

/** Load manifest once per batch per session; dedupe concurrent fetches. */
async function loadMintProofManifest(
  product: 'eth' | 'btc',
  batchCycle: bigint,
): Promise<MintProofManifest | null> {
  const key = manifestCacheKey(product, batchCycle);
  const cached = mintManifestCache.get(key);
  if (cached) return cached;

  let inflight = mintManifestInflight.get(key);
  if (!inflight) {
    inflight = fetchMintProofManifest(product, batchCycle).then((manifest) => {
      mintManifestInflight.delete(key);
      if (manifest) mintManifestCache.set(key, manifest);
      return manifest;
    });
    mintManifestInflight.set(key, inflight);
  }
  return inflight;
}

function proofFromManifest(
  manifest: MintProofManifest,
  userAddress: string,
): { amount: bigint; proof: `0x${string}`[] } | null {
  const leaf = manifest.leaves.find(
    (l) => l.user.toLowerCase() === userAddress.toLowerCase(),
  );
  if (!leaf) return null;
  const amount = leafKashAmount(leaf);
  if (amount == null) return null;
  return {
    amount,
    proof: leaf.proof as `0x${string}`[],
  };
}

export async function fetchMintProof(
  product: 'eth' | 'btc',
  batchCycle: bigint,
  userAddress: string,
): Promise<{ amount: bigint; proof: `0x${string}`[] } | null> {
  const manifest = await loadMintProofManifest(product, batchCycle);
  if (!manifest) return null;
  return proofFromManifest(manifest, userAddress);
}

/** Prefer hosted manifest (O(1) HTTP); on-chain rebuild is fallback when manifest is missing. */
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

  const manifest = await loadMintProofManifest(product, batchCycle);
  if (manifest) {
    const fromManifest = proofFromManifest(manifest, userAddress);
    if (fromManifest) return fromManifest;
  }

  if (publicClient && kashYield) {
    return buildMintClaimProofFromChain(publicClient, kashYield, batchCycle, userAddress);
  }
  return null;
}
