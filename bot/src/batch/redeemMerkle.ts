import { AbiCoder, keccak256, getBytes, concat } from 'ethers';

export interface RedeemLeaf {
  user: string;
  amount: bigint;
}

export interface RedeemMerkleManifest {
  batchCycle: string;
  root: string;
  leaves: Array<{
    user: string;
    amount: string;
    proof: string[];
  }>;
}

function hashLeaf(batchCycle: bigint, user: string, amount: bigint): string {
  return keccak256(
    AbiCoder.defaultAbiCoder().encode(['uint256', 'address', 'uint256'], [batchCycle, user, amount]),
  );
}

function hashPair(a: string, b: string): string {
  const [left, right] = a.toLowerCase() <= b.toLowerCase() ? [a, b] : [b, a];
  return keccak256(concat([getBytes(left), getBytes(right)]));
}

/** Build sorted-pair Merkle tree matching on-chain MerkleVerify / OpenZeppelin layout. */
export function buildRedeemMerkleTree(
  batchCycle: bigint,
  entries: RedeemLeaf[],
): { root: string; proofs: Map<string, string[]> } {
  const active = entries.filter((e) => e.amount > 0n);
  if (active.length === 0) {
    return { root: `0x${'0'.repeat(64)}`, proofs: new Map() };
  }

  const leaves = active.map((e) => hashLeaf(batchCycle, e.user, e.amount));
  let layer = leaves;
  const proofs: string[][] = active.map(() => []);

  while (layer.length > 1) {
    const next: string[] = [];
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

  const proofMap = new Map<string, string[]>();
  active.forEach((e, idx) => {
    proofMap.set(e.user.toLowerCase(), proofs[idx]);
  });

  return { root: layer[0], proofs: proofMap };
}

export function manifestFromTree(
  batchCycle: bigint,
  entries: RedeemLeaf[],
  root: string,
  proofs: Map<string, string[]>,
): RedeemMerkleManifest {
  return {
    batchCycle: batchCycle.toString(),
    root,
    leaves: entries
      .filter((e) => e.amount > 0n)
      .map((e) => ({
        user: e.user,
        amount: e.amount.toString(),
        proof: proofs.get(e.user.toLowerCase()) ?? [],
      })),
  };
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
    const gross = kashLeft === kash
      ? grossLeft
      : (totalGrossRedeem * kash) / totalRedeemKash;
    kashLeft -= kash;
    grossLeft -= gross;
    const fee = (gross * feeBps) / 10000n;
    amounts[i] = gross - fee;
  }

  return redeemers.map((user, i) => ({ user, amount: amounts[i] }));
}
