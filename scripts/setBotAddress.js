// scripts/setBotAddress.js
// Sets the bot address on the deployed KashYieldETH contract.
// Usage: npx hardhat run scripts/setBotAddress.js --network arbitrumSepolia

require("dotenv").config();
const hre = require("hardhat");

async function main() {
  const KASH_YIELD_ADDRESS =
    process.env.KASH_YIELD_ADDRESS || "0xf78854a9B5D28DdB1B35a60553e22481fE87d759";
  const BOT_ADDRESS = process.env.BOT_ADDRESS || "";

  if (!BOT_ADDRESS) {
    throw new Error(
      "Set BOT_ADDRESS in .env to the bot wallet address (e.g. 0xBc5247120e67E9841f15745cF5586C852C7Ce353)"
    );
  }
  if (!hre.ethers.isAddress(BOT_ADDRESS)) {
    throw new Error("Invalid BOT_ADDRESS");
  }

  console.log("Network:", hre.network.name);
  console.log("KashYieldETH:", KASH_YIELD_ADDRESS);
  console.log("New bot address:", BOT_ADDRESS);
  console.log("\nConnecting to KashYieldETH...");
  const KashYieldETH = await hre.ethers.getContractAt("KashYieldETH", KASH_YIELD_ADDRESS);

  const owner = await KashYieldETH.owner();
  const [signer] = await hre.ethers.getSigners();
  if (signer.address.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(`Signer ${signer.address} is not the contract owner (${owner})`);
  }

  console.log("Current bot address:", await KashYieldETH.botAddress());
  console.log("Setting bot address...");
  const tx = await KashYieldETH.setBotAddress(BOT_ADDRESS);
  console.log("Transaction sent:", tx.hash);
  await tx.wait();
  console.log("✅ Bot address updated!");
  console.log("New bot address:", await KashYieldETH.botAddress());
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
