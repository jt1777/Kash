// scripts/setEthOracle.js
// Sets the ETH/USD price feed oracle address on KashYieldETH.
//
// This is needed when using a MockChainlinkPriceFeed on testnet so KashYieldETH
// reads that feed (you can call setPrice() on the mock for simulations).
// Without this, KashYieldETH uses the built-in default (real Chainlink),
// which cannot have its price overridden.
//
// Usage:
//   KASH_YIELD_ETH_ADDRESS=<KashYieldETH> \
//   ETH_ORACLE_ADDRESS=<MockChainlinkPriceFeed> \
//   npx hardhat run scripts/setEthOracle.js --network arbitrumSepolia

require("dotenv").config();
const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network = hre.network.name;

  const kashYieldAddress = process.env.KASH_YIELD_ETH_ADDRESS || process.env.KASH_YIELD_ADDRESS;
  const oracleAddress    = process.env.ETH_ORACLE_ADDRESS;

  if (!kashYieldAddress || !hre.ethers.isAddress(kashYieldAddress)) {
    throw new Error("Set KASH_YIELD_ETH_ADDRESS=<KashYieldETH address> in .env");
  }
  if (!oracleAddress || !hre.ethers.isAddress(oracleAddress)) {
    throw new Error("Set ETH_ORACLE_ADDRESS=<MockChainlinkPriceFeed address> in .env");
  }

  console.log("Network:        ", network);
  console.log("Deployer:       ", deployer.address);
  console.log("KashYieldETH:   ", kashYieldAddress);
  console.log("ETH oracle:     ", oracleAddress);

  const kashYield = await hre.ethers.getContractAt("KashYieldETH", kashYieldAddress);
  const tx = await kashYield.setEthOracle(oracleAddress);
  await tx.wait();

  const current = await kashYield.ethOracle();
  console.log("\n✅ ethOracle set to:", current);

  // Sanity-check: read the price from the new oracle
  try {
    const price = await kashYield.getEthPrice();
    console.log("✅ getEthPrice() =", hre.ethers.formatUnits(price, 18), "USD (18-dec)");
  } catch (e) {
    console.warn("⚠️  getEthPrice() reverted — oracle may need a price set:");
    console.warn("   On a mock feed, call setPrice on MockChainlinkPriceFeed; sync MockAaveV3/MockHyperliquid if your stack uses them.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
