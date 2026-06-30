/**
 * Predict CREATE contract addresses from an EOA's pending nonce.
 * Used to wire immutable circular deps (adapter ↔ facade ↔ vault) in one deploy run.
 */
async function predictContractAddress(signerOrAddress, offset = 0) {
  const hre = require("hardhat");
  const from =
    typeof signerOrAddress === "string" ? signerOrAddress : await signerOrAddress.getAddress();
  const nonce = await hre.ethers.provider.getTransactionCount(from);
  return hre.ethers.getCreateAddress({ from, nonce: nonce + offset });
}

function assertDeployedAddress(label, actual, expected) {
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`${label} address mismatch: got ${actual}, expected ${expected}`);
  }
}

module.exports = { predictContractAddress, assertDeployedAddress };
