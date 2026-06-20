/**
 * Keep in sync with kash-ops bot/src/batch/mintMerkle.ts (pure helpers only).
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

function buildMintMerkleTree(batchCycle, entries) {
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

/** Pro-rata KASH mint allocation with last-minter dust rule (mirrors redeem helper). */
function allocMintKashAmounts(minters, amountInUSD, totalMintUSD, totalMintKash) {
  const amounts = new Array(minters.length).fill(0n);
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

module.exports = {
  allocMintKashAmounts,
  buildMintMerkleTree,
};
