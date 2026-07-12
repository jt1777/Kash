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

/** Proofs use per-layer sibling indices so 3+ leaves verify (not just the first pair). */
function buildRedeemMerkleTree(batchCycle, entries) {
  const active = entries.filter((e) => e.amount > 0n);
  if (active.length === 0) {
    return { root: `0x${"0".repeat(64)}`, proofs: new Map() };
  }

  const leaves = active.map((e) => hashLeaf(batchCycle, e.user, e.amount));
  const layers = [leaves];
  while (layers[layers.length - 1].length > 1) {
    const prev = layers[layers.length - 1];
    const next = [];
    for (let i = 0; i < prev.length; i += 2) {
      if (i + 1 === prev.length) {
        next.push(prev[i]);
      } else {
        next.push(hashPair(prev[i], prev[i + 1]));
      }
    }
    layers.push(next);
  }

  const proofs = leaves.map((_, index) => {
    const proof = [];
    let idx = index;
    for (let layerIdx = 0; layerIdx < layers.length - 1; layerIdx++) {
      const layer = layers[layerIdx];
      const siblingIndex = idx % 2 === 0 ? idx + 1 : idx - 1;
      if (siblingIndex < layer.length) {
        proof.push(layer[siblingIndex]);
      }
      idx = Math.floor(idx / 2);
    }
    return proof;
  });

  const proofMap = new Map();
  active.forEach((e, idx) => {
    proofMap.set(e.user.toLowerCase(), proofs[idx]);
  });

  return { root: layers[layers.length - 1][0], proofs: proofMap };
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
