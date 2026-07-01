import type { PublicClient } from 'viem';
import { concat, encodeAbiParameters, keccak256, type Hex } from 'viem';
import { kashYieldABI } from '@/lib/contracts/kashYieldABI';

export type MintLeaf = { user: string; amount: bigint };

function hashLeaf(batchCycle: bigint, user: string, amount: bigint): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'address' }, { type: 'uint256' }],
      [batchCycle, user as `0x${string}`, amount],
    ),
  );
}

function hashPair(a: Hex, b: Hex): Hex {
  const [left, right] = a.toLowerCase() <= b.toLowerCase() ? [a, b] : [b, a];
  return keccak256(concat([left, right]));
}

export function buildMintMerkleTree(
  batchCycle: bigint,
  entries: MintLeaf[],
): { root: Hex; proofs: Map<string, Hex[]> } {
  const active = entries.filter((e) => e.amount > 0n);
  if (active.length === 0) {
    return { root: `0x${'0'.repeat(64)}`, proofs: new Map() };
  }

  const leaves = active.map((e) => hashLeaf(batchCycle, e.user, e.amount));
  let layer = leaves;
  const proofs: Hex[][] = active.map(() => []);

  while (layer.length > 1) {
    const next: Hex[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      if (i + 1 === layer.length) {
        next.push(layer[i]);
        continue;
      }
      const parent = hashPair(layer[i], layer[i + 1]);
      next.push(parent);
      for (let j = 0; j < 2; j++) {
        const leafIdx = i + j;
        if (leafIdx < proofs.length) {
          proofs[leafIdx].push(layer[i + 1 - j]);
        }
      }
    }
    layer = next;
  }

  const proofMap = new Map<string, Hex[]>();
  active.forEach((e, idx) => {
    proofMap.set(e.user.toLowerCase(), proofs[idx]);
  });

  return { root: layer[0], proofs: proofMap };
}

export function allocMintKashAmounts(
  minters: string[],
  amountInUSD: bigint[],
  totalMintUSD: bigint,
  totalMintKash: bigint,
): MintLeaf[] {
  const amounts: bigint[] = new Array(minters.length).fill(0n);
  let usdLeft = totalMintUSD;
  let kashLeft = totalMintKash;

  for (let i = 0; i < minters.length; i++) {
    const usd = amountInUSD[i];
    if (usd === 0n) continue;
    const share = usdLeft === usd ? kashLeft : (totalMintKash * usd) / totalMintUSD;
    usdLeft -= usd;
    kashLeft -= share;
    amounts[i] = share;
  }

  return minters.map((user, i) => ({ user, amount: amounts[i] }));
}

async function loadBatchMintData(
  client: PublicClient,
  kashYield: `0x${string}`,
  batchCycle: bigint,
) {
  const [batchInfo, claimInfo] = await Promise.all([
    client.readContract({
      address: kashYield,
      abi: kashYieldABI,
      functionName: 'getBatchInfo',
      args: [batchCycle],
    }),
    client.readContract({
      address: kashYield,
      abi: kashYieldABI,
      functionName: 'batchClaimInfo',
      args: [batchCycle],
    }),
  ]);

  const [totalMintUSD, , processed, mintUsersCount] = batchInfo;
  const totalMintClaimable = claimInfo[3];
  if (!processed || totalMintClaimable === 0n) return null;

  const minters: `0x${string}`[] = [];
  const amountInUSD: bigint[] = [];
  const count = Number(mintUsersCount);

  for (let i = 0; i < count; i++) {
    const minter = await client.readContract({
      address: kashYield,
      abi: kashYieldABI,
      functionName: 'batchMintUsers',
      args: [batchCycle, BigInt(i)],
    });
    const usd = await client.readContract({
      address: kashYield,
      abi: kashYieldABI,
      functionName: 'getMintRequestUSD',
      args: [minter, batchCycle],
    });
    minters.push(minter);
    amountInUSD.push(usd);
  }

  return { minters, amountInUSD, totalMintUSD, totalMintClaimable, mintRoot: claimInfo[1] as Hex };
}

export async function buildMintClaimProofFromChain(
  client: PublicClient,
  kashYield: `0x${string}`,
  batchCycle: bigint,
  userAddress: `0x${string}`,
): Promise<{ amount: bigint; proof: `0x${string}`[] } | null> {
  const batch = await loadBatchMintData(client, kashYield, batchCycle);
  if (!batch) return null;

  const entries = allocMintKashAmounts(
    batch.minters,
    batch.amountInUSD,
    batch.totalMintUSD,
    batch.totalMintClaimable,
  );
  const { root, proofs } = buildMintMerkleTree(batchCycle, entries);
  if (root.toLowerCase() !== batch.mintRoot.toLowerCase()) return null;

  const userKey = userAddress.toLowerCase();
  const proof = proofs.get(userKey);
  const entry = entries.find((e) => e.user.toLowerCase() === userKey);
  if (!proof || !entry || entry.amount === 0n) return null;

  return {
    amount: entry.amount,
    proof: proof as `0x${string}`[],
  };
}
