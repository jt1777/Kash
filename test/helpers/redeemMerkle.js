/**
 * Keep in sync with kash-ops bot/src/batch/redeemMerkle.ts (pure helpers only).
 */

const { AbiCoder, keccak256, getBytes, concat } = require("ethers");

function hashLeaf(batchCycle, user, amount) {
  return keccak256(
    AbiCoder.defaultAbiCoder().encode(["uint256", "address", "uint256"], [batchCycle, user, amount]),
  );
}

function hashPair(a, b) {
  const [left, right] = a.toLowerCase() <= b.toLowerCase() ? [a, b] : [b, a];
  return keccak256(concat([getBytes(left), getBytes(right)]));
}

function buildRedeemMerkleTree(batchCycle, entries) {
  const active = entries.filter((e) => e.amount > 0n);
  if (active.length === 0) {
    return { root: `0x${"0".repeat(64)}`, proofs: new Map() };
  }

  const leaves = active.map((e) => hashLeaf(batchCycle, e.user, e.amount));
  let layer = leaves;
  const proofs = active.map(() => []);

  while (layer.length > 1) {
    const next = [];
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

  const proofMap = new Map();
  active.forEach((e, idx) => {
    proofMap.set(e.user.toLowerCase(), proofs[idx]);
  });

  return { root: layer[0], proofs: proofMap };
}

function allocRedeemNetAmounts(redeemers, kashAmounts, totalRedeemKash, totalGrossRedeem, feeBps) {
  const amounts = new Array(redeemers.length).fill(0n);
  let kashLeft = totalRedeemKash;
  let grossLeft = totalGrossRedeem;

  for (let i = 0; i < redeemers.length; i++) {
    const kash = kashAmounts[i];
    if (kash === 0n) continue;
    const gross = kashLeft === kash ? grossLeft : (totalGrossRedeem * kash) / totalRedeemKash;
    kashLeft -= kash;
    grossLeft -= gross;
    const fee = (gross * feeBps) / 10000n;
    amounts[i] = gross - fee;
  }

  return redeemers.map((user, i) => ({ user, amount: amounts[i] }));
}

module.exports = {
  allocRedeemNetAmounts,
  buildRedeemMerkleTree,
};
