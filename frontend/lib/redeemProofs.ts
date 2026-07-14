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

function manifestCacheKey(product: 'eth' | 'btc', batchCycle: bigint): string {
  return `${product}:${batchCycle.toString()}`;
}

const redeemManifestCache = new Map<string, RedeemProofManifest>();
const redeemManifestInflight = new Map<string, Promise<RedeemProofManifest | null>>();

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

/** Load manifest once per batch per session; dedupe concurrent fetches. */
async function loadRedeemProofManifest(
  product: 'eth' | 'btc',
  batchCycle: bigint,
): Promise<RedeemProofManifest | null> {
  const key = manifestCacheKey(product, batchCycle);
  const cached = redeemManifestCache.get(key);
  if (cached) return cached;

  let inflight = redeemManifestInflight.get(key);
  if (!inflight) {
    inflight = fetchRedeemProofManifest(product, batchCycle).then((manifest) => {
      redeemManifestInflight.delete(key);
      if (manifest) redeemManifestCache.set(key, manifest);
      return manifest;
    });
    redeemManifestInflight.set(key, inflight);
  }
  return inflight;
}

function proofFromManifest(
  manifest: RedeemProofManifest,
  userAddress: string,
): { amount: bigint; proof: `0x${string}`[] } | null {
  const leaf = manifest.leaves.find(
    (l) => l.user.toLowerCase() === userAddress.toLowerCase(),
  );
  if (!leaf || leaf.amount === '') return null;
  try {
    const amount = BigInt(leaf.amount);
    if (amount === 0n) return null;
    return {
      amount,
      proof: leaf.proof as `0x${string}`[],
    };
  } catch {
    return null;
  }
}

export async function fetchRedeemProof(
  product: 'eth' | 'btc',
  batchCycle: bigint,
  userAddress: string,
): Promise<{ amount: bigint; proof: `0x${string}`[] } | null> {
  const manifest = await loadRedeemProofManifest(product, batchCycle);
  if (!manifest) return null;
  return proofFromManifest(manifest, userAddress);
}

/** Prefer hosted manifest (O(1) HTTP); on-chain rebuild is fallback when manifest is missing. */
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

  const manifest = await loadRedeemProofManifest(product, batchCycle);
  if (manifest) {
    const fromManifest = proofFromManifest(manifest, userAddress);
    if (fromManifest) return fromManifest;
  }

  if (publicClient && kashYield) {
    return buildClaimProofFromChain(publicClient, kashYield, batchCycle, userAddress);
  }
  return null;
}
