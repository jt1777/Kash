import type { PublicClient } from 'viem';
import { concat, encodeAbiParameters, keccak256, type Hex } from 'viem';
import { kashYieldABI } from '@/lib/contracts/kashYieldABI';

export type RedeemLeaf = { user: string; amount: bigint };

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

/** Build sorted-pair Merkle tree matching on-chain MerkleVerify / OpenZeppelin layout. */
export function buildRedeemMerkleTree(
  batchCycle: bigint,
  entries: RedeemLeaf[],
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

/** Mirror on-chain _allocRedeem* pro-rata with fee and last-redeemer dust rule. */
export function allocRedeemNetAmounts(
  redeemers: string[],
  kashAmounts: bigint[],
  totalRedeemKash: bigint,
  totalGrossRedeem: bigint,
  feeBps: bigint,
): RedeemLeaf[] {
  const amounts: bigint[] = new Array(redeemers.length).fill(0n);
  let kashLeft = totalRedeemKash;
  let grossLeft = totalGrossRedeem;

  for (let i = 0; i < redeemers.length; i++) {
    const kash = kashAmounts[i];
    if (kash === 0n) continue;
    const gross =
      kashLeft === kash ? grossLeft : (totalGrossRedeem * kash) / totalRedeemKash;
    kashLeft -= kash;
    grossLeft -= gross;
    const fee = (gross * feeBps) / 10000n;
    amounts[i] = gross - fee;
  }

  return redeemers.map((user, i) => ({ user, amount: amounts[i] }));
}

export function netClaimForUser(
  userAddress: string,
  redeemers: string[],
  kashAmounts: bigint[],
  totalRedeemKash: bigint,
  totalGrossRedeem: bigint,
  feeBps: bigint,
): bigint {
  const entries = allocRedeemNetAmounts(
    redeemers,
    kashAmounts,
    totalRedeemKash,
    totalGrossRedeem,
    feeBps,
  );
  const leaf = entries.find((e) => e.user.toLowerCase() === userAddress.toLowerCase());
  return leaf?.amount ?? 0n;
}

export async function computeClaimPayoutFromChain(
  client: PublicClient,
  kashYield: `0x${string}`,
  batchCycle: bigint,
  userAddress: `0x${string}`,
): Promise<bigint | null> {
  const proof = await buildClaimProofFromChain(client, kashYield, batchCycle, userAddress);
  return proof?.amount ?? null;
}

async function loadBatchRedeemData(
  client: PublicClient,
  kashYield: `0x${string}`,
  batchCycle: bigint,
) {
  const [batchInfo, feeBps] = await Promise.all([
    client.readContract({
      address: kashYield,
      abi: kashYieldABI,
      functionName: 'getBatchInfo',
      args: [batchCycle],
    }),
    client.readContract({
      address: kashYield,
      abi: kashYieldABI,
      functionName: 'feeBps',
    }),
  ]);

  const [, totalGrossRedeem, processed, , redeemUsersCount, totalRedeemKash] = batchInfo;
  if (!processed || totalRedeemKash === 0n) return null;

  const redeemers: `0x${string}`[] = [];
  const kashAmounts: bigint[] = [];
  const count = Number(redeemUsersCount);

  for (let i = 0; i < count; i++) {
    const redeemer = await client.readContract({
      address: kashYield,
      abi: kashYieldABI,
      functionName: 'batchRedeemUsers',
      args: [batchCycle, BigInt(i)],
    });
    const req = await client.readContract({
      address: kashYield,
      abi: kashYieldABI,
      functionName: 'getPendingRedeemRequest',
      args: [redeemer, batchCycle],
    });
    redeemers.push(redeemer);
    kashAmounts.push(req.kashAmount);
  }

  return { redeemers, kashAmounts, totalRedeemKash, totalGrossRedeem, feeBps };
}

export async function buildClaimProofFromChain(
  client: PublicClient,
  kashYield: `0x${string}`,
  batchCycle: bigint,
  userAddress: `0x${string}`,
): Promise<{ amount: bigint; proof: `0x${string}`[] } | null> {
  const batch = await loadBatchRedeemData(client, kashYield, batchCycle);
  if (!batch) return null;

  const entries = allocRedeemNetAmounts(
    batch.redeemers,
    batch.kashAmounts,
    batch.totalRedeemKash,
    batch.totalGrossRedeem,
    batch.feeBps,
  );
  const { root, proofs } = buildRedeemMerkleTree(batchCycle, entries);

  const claimInfo = await client.readContract({
    address: kashYield,
    abi: kashYieldABI,
    functionName: 'batchClaimInfo',
    args: [batchCycle],
  });
  if (root.toLowerCase() !== claimInfo[0].toLowerCase()) return null;

  const userKey = userAddress.toLowerCase();
  const proof = proofs.get(userKey);
  const entry = entries.find((e) => e.user.toLowerCase() === userKey);
  if (!proof || !entry || entry.amount === 0n) return null;

  return {
    amount: entry.amount,
    proof: proof as `0x${string}`[],
  };
}
