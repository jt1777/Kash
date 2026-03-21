/**
 * Call setSpotDex on KashYieldETH or KashYieldBtc. Owner only.
 *
 * Usage:
 *   KASH_YIELD_ETH_ADDRESS=0x... MOCK_SPOT_DEX_ADDRESS=0x... \
 *   npx hardhat run scripts/setSpotDex.js --network arbitrumSepolia
 *
 *   BTC: KASH_YIELD_BTC_ADDRESS=0x... MOCK_SPOT_DEX_ADDRESS=0x... PRODUCT=btc \
 *   npx hardhat run scripts/setSpotDex.js --network arbitrumSepolia
 */
require("dotenv").config();
const hre = require("hardhat");

async function main() {
  const productEnv = (process.env.PRODUCT || "").toLowerCase();
  const kashYieldBtcAddress = process.env.KASH_YIELD_BTC_ADDRESS;
  const kashYieldEthAddress = process.env.KASH_YIELD_ETH_ADDRESS || process.env.KASH_YIELD_ADDRESS;
  const spotDexAddress = process.env.MOCK_SPOT_DEX_ADDRESS;

  const isBtc =
    productEnv === "btc" ||
    (productEnv !== "eth" && kashYieldBtcAddress && hre.ethers.isAddress(kashYieldBtcAddress) && !kashYieldEthAddress);
  const kashYieldAddress = isBtc ? kashYieldBtcAddress : kashYieldEthAddress;

  if (!spotDexAddress || !hre.ethers.isAddress(spotDexAddress)) {
    throw new Error("Set MOCK_SPOT_DEX_ADDRESS in .env");
  }
  if (!kashYieldAddress || !hre.ethers.isAddress(kashYieldAddress)) {
    throw new Error("Set KASH_YIELD_ETH_ADDRESS (ETH) or KASH_YIELD_BTC_ADDRESS (BTC) in .env");
  }

  const [signer] = await hre.ethers.getSigners();
  const contractName = isBtc ? "KashYieldBtc" : "KashYieldETH";
  const kashYield = await hre.ethers.getContractAt(contractName, kashYieldAddress);
  const owner = await kashYield.owner();

  if (signer.address.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(`Signer ${signer.address} is not owner of ${contractName} (owner: ${owner}). Use the owner wallet's PRIVATE_KEY.`);
  }

  const tx = await kashYield.setSpotDex(spotDexAddress);
  await tx.wait();
  console.log("✅ setSpotDex(" + spotDexAddress + ") on " + contractName);
}

main().catch((e) => { console.error(e); process.exit(1); });
