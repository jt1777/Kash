export type RedeemProofManifest = {
  batchCycle: string;
  root: string;
  leaves: Array<{ user: string; amount: string; proof: string[] }>;
};

export async function fetchRedeemProof(
  product: 'eth' | 'btc',
  batchCycle: bigint,
  userAddress: string,
): Promise<{ amount: bigint; proof: `0x${string}`[] } | null> {
  const base = process.env.NEXT_PUBLIC_REDEEM_PROOF_BASE_URL?.replace(/\/+$/, '');
  if (!base) return null;
  const url = `${base}/${product}-batch-${batchCycle.toString()}.json`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) return null;
  const manifest = (await res.json()) as RedeemProofManifest;
  const leaf = manifest.leaves.find(
    (l) => l.user.toLowerCase() === userAddress.toLowerCase(),
  );
  if (!leaf) return null;
  return {
    amount: BigInt(leaf.amount),
    proof: leaf.proof as `0x${string}`[],
  };
}
