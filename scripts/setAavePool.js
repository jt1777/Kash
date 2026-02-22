// scripts/setAavePool.js
// Updates the Aave pool address on the deployed KashYieldETH contract.
// Requires: .env with PRIVATE_KEY; signer must be contract owner.
// Usage: npx hardhat run scripts/setAavePool.js --network arbitrumSepolia

require("dotenv").config();
const hre = require("hardhat");

async function main() {
  const KASH_YIELD_ADDRESS =
    process.env.KASH_YIELD_ADDRESS || "0x4C3910E93aB0c5983c6DEE003749485E525E5Db7";
  const newAavePool =
    process.env.AAVE_POOL_ADDRESS || "0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff";

  if (!hre.ethers.isAddress(newAavePool)) {
    throw new Error("Invalid AAVE_POOL_ADDRESS (set in .env or use default)");
  }

  console.log("Network:", hre.network.name);
  console.log("KashYieldETH:", KASH_YIELD_ADDRESS);
  console.log("New Aave pool:", newAavePool);
  console.log("\nConnecting to KashYieldETH...");
  const KashYieldETH = await hre.ethers.getContractAt("KashYieldETH", KASH_YIELD_ADDRESS);

  const owner = await KashYieldETH.owner();
  const [signer] = await hre.ethers.getSigners();
  if (signer.address.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(`Signer ${signer.address} is not the contract owner (${owner})`);
  }
  console.log("Current Aave pool:", await KashYieldETH.aavePoolAddress());
  console.log("\nSetting Aave pool address...");
  const tx = await KashYieldETH.setAavePool(newAavePool);
  console.log("Transaction sent:", tx.hash);
  await tx.wait();
  console.log("✅ Aave pool address updated!");
  console.log("New Aave pool:", await KashYieldETH.aavePoolAddress());
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
});