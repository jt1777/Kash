// scripts/deploy-mock-price-feeds.js
// Deploys two MockChainlinkPriceFeed contracts — one for BTC/USD and one for ETH/USD.
//
// These are needed so that scripts/setAssetPrice.ts can update the oracle price
// for price-change simulations. Without them the contracts point to the real
// Chainlink feeds (read-only; setPrice() would revert).
//
// Usage:
//   npx hardhat run scripts/deploy-mock-price-feeds.js --network arbitrumSepolia
//
// Optional env vars (override defaults):
//   BTC_PRICE_USD   — initial BTC price in USD, default 45000
//   ETH_PRICE_USD   — initial ETH price in USD, default 3000
//
// After running, add to root .env AND bot/.env:
//   BTC_ORACLE_ADDRESS=<BTC feed>
//   ETH_ORACLE_ADDRESS=<ETH feed>
// Then call setEthOracle / setBtcOracle on your KashYield contracts (see Step 9 / BTC Step 2).

require("dotenv").config();
const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network = hre.network.name;

  console.log("Deploying mock Chainlink price feeds to", network);
  console.log("Deployer:", deployer.address);

  const btcPriceUsd = BigInt(process.env.BTC_PRICE_USD || "45000");
  const ethPriceUsd = BigInt(process.env.ETH_PRICE_USD || "3000");

  // Chainlink uses 8 decimals for USD price feeds
  const btcAnswer = btcPriceUsd * 10n ** 8n;
  const ethAnswer = ethPriceUsd * 10n ** 8n;

  const MockFeed = await hre.ethers.getContractFactory("MockChainlinkPriceFeed");

  const btcFeed = await MockFeed.deploy(btcAnswer);
  await btcFeed.waitForDeployment();
  const btcFeedAddress = await btcFeed.getAddress();
  console.log("✅ BTC/USD feed ($" + btcPriceUsd + "):", btcFeedAddress);

  const ethFeed = await MockFeed.deploy(ethAnswer);
  await ethFeed.waitForDeployment();
  const ethFeedAddress = await ethFeed.getAddress();
  console.log("✅ ETH/USD feed ($" + ethPriceUsd + "):", ethFeedAddress);

  console.log("\n====================================");
  console.log("📋 MOCK PRICE FEEDS");
  console.log("====================================");
  console.log("  BTC/USD feed:", btcFeedAddress);
  console.log("  ETH/USD feed:", ethFeedAddress);
  console.log("  BTC price:  $" + btcPriceUsd.toLocaleString());
  console.log("  ETH price:  $" + ethPriceUsd.toLocaleString());
  console.log("====================================");
  console.log("\nAdd to root .env AND bot/.env:");
  console.log("  BTC_ORACLE_ADDRESS=" + btcFeedAddress);
  console.log("  ETH_ORACLE_ADDRESS=" + ethFeedAddress);
  console.log("\nNext steps:");
  console.log("  1. Set BTC oracle on KashYieldBtc (done automatically by deploy-kashyieldbtc.js if BTC_ORACLE_ADDRESS is set)");
  console.log("  2. Set ETH oracle on KashYieldETH:");
  console.log("       KASH_YIELD_ETH_ADDRESS=<addr> ETH_ORACLE_ADDRESS=" + ethFeedAddress);
  console.log("       npx hardhat run scripts/setEthOracle.js --network " + network);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
