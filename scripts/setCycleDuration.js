// scripts/setCycleDuration.js
// Set the batch cycle duration (in seconds) on KashYieldBtc and/or KashYieldETH.
// Only owner can call. Min 60 seconds. Use 86400 for production (1 day), 3600 for 1 hour testing.
//
// Usage (from repo root):
//   CYCLE_SECONDS=3600 npx hardhat run scripts/setCycleDuration.js --network arbitrumSepolia
//   CYCLE_SECONDS=3600 PRODUCT=btc npx hardhat run scripts/setCycleDuration.js --network arbitrumSepolia
//   CYCLE_SECONDS=3600 PRODUCT=eth npx hardhat run scripts/setCycleDuration.js --network arbitrumSepolia
//
// Env (root .env, i.e. repo root — not bot/.env):
//   CYCLE_SECONDS  - duration in seconds (required). e.g. 3600 = 1 hour, 86400 = 1 day
//   PRODUCT        - "btc" | "eth" | "both" (default: both). Which contract(s) to update.
//   KASH_YIELD_BTC_ADDRESS, KASH_YIELD_ETH_ADDRESS - contract addresses
//   PRIVATE_KEY    - owner wallet (used to sign setCycleDurationSeconds tx)

require("dotenv").config();
const hre = require("hardhat");

async function main() {
  const raw = process.env.CYCLE_SECONDS;
  if (!raw || isNaN(Number(raw))) {
    throw new Error("Set CYCLE_SECONDS=<number> in env (e.g. CYCLE_SECONDS=3600 for 1 hour).");
  }
  const seconds = BigInt(raw);
  if (seconds < 60n) {
    throw new Error("CYCLE_SECONDS must be at least 60.");
  }

  const product = (process.env.PRODUCT || "both").toLowerCase();
  const [signer] = await hre.ethers.getSigners();

  const label = seconds === 86400n ? "1 day" : seconds === 3600n ? "1 hour" : `${seconds} seconds`;
  console.log(`Setting cycle duration to ${seconds} (${label}) for product(s): ${product}\n`);

  if (product === "btc" || product === "both") {
    const addr = process.env.KASH_YIELD_BTC_ADDRESS || process.env.KASH_YIELD_ADDRESS;
    if (!addr || !hre.ethers.isAddress(addr)) {
      throw new Error("Set KASH_YIELD_BTC_ADDRESS in .env for BTC product.");
    }
    const kashYield = await hre.ethers.getContractAt("KashYieldBtc", addr);
    const owner = await kashYield.owner();
    if (signer.address.toLowerCase() !== owner.toLowerCase()) {
      throw new Error(`Signer ${signer.address} is not owner of KashYieldBtc (${owner}).`);
    }
    const tx = await kashYield.setCycleDurationSeconds(seconds);
    await tx.wait();
    console.log(`  KashYieldBtc (${addr}): setCycleDurationSeconds(${seconds}) done.`);
  }

  if (product === "eth" || product === "both") {
    const addr = process.env.KASH_YIELD_ETH_ADDRESS || process.env.KASH_YIELD_ADDRESS;
    if (!addr || !hre.ethers.isAddress(addr)) {
      throw new Error("Set KASH_YIELD_ETH_ADDRESS in .env for ETH product.");
    }
    const kashYield = await hre.ethers.getContractAt("KashYieldETH", addr);
    const owner = await kashYield.owner();
    if (signer.address.toLowerCase() !== owner.toLowerCase()) {
      throw new Error(`Signer ${signer.address} is not owner of KashYieldETH (${owner}).`);
    }
    const tx = await kashYield.setCycleDurationSeconds(seconds);
    await tx.wait();
    console.log(`  KashYieldETH (${addr}): setCycleDurationSeconds(${seconds}) done.`);
  }

  console.log("\nDone.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
