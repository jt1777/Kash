// scripts/deploy-kashyieldbtc.js
// Deploys only KashYieldBtc (and its built-in KashTokenBtc). Uses existing wBTC, Aave pool, USDC, and BTC oracle from env.
// Does NOT deploy MockUSDC, MockWBTC, MockAaveV3, or price feed — use existing deployments (e.g. from a previous full deploy).
// For mainnet you will change addresses in .env and redeploy this script.
//
// Usage:
//   npx hardhat run scripts/deploy-kashyieldbtc.js --network arbitrumSepolia
//
// Env (required for configuration after deploy):
//   WBTC_ADDRESS         — wBTC (or MockWBTC) contract address
//   AAVE_POOL_ADDRESS    — Aave pool (or MockAaveV3) address
//   USDC_ADDRESS         — USDC (or MockUSDC) address for HL and Aave
//   BTC_ORACLE_ADDRESS   — BTC/USD price feed (or MockChainlinkPriceFeed) address
//
// Env (optional):
//   BOT_ADDRESS          — bot/keeper for performUpkeep; defaults to deployer
//
// KASH-BTC token: The contract creates a new KashTokenBtc in its constructor (one per KashYieldBtc).
// To reuse an existing KASH-BTC token would require a contract change (e.g. constructor arg). Not done here.

require("dotenv").config();
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network = hre.network.name;

  console.log("Deploying KashYieldBtc only to", network);
  console.log("Deployer:", deployer.address);
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Balance:", hre.ethers.formatEther(balance), "ETH\n");

  const botAddress = process.env.BOT_ADDRESS || deployer.address;

  const wbtcAddress = process.env.WBTC_ADDRESS || process.env.MOCK_WBTC || process.env.NEXT_PUBLIC_MOCK_WBTC;
  const aavePoolAddress = process.env.AAVE_POOL_ADDRESS;
  const usdcAddress = process.env.USDC_ADDRESS;
  const btcOracleAddress = process.env.BTC_ORACLE_ADDRESS || process.env.BTC_ORACLE;

  if (!wbtcAddress || !hre.ethers.isAddress(wbtcAddress)) {
    throw new Error("Set WBTC_ADDRESS (or MOCK_WBTC / NEXT_PUBLIC_MOCK_WBTC) to existing wBTC contract");
  }
  if (!aavePoolAddress || !hre.ethers.isAddress(aavePoolAddress)) {
    throw new Error("Set AAVE_POOL_ADDRESS to existing Aave pool (or MockAaveV3)");
  }
  if (!usdcAddress || !hre.ethers.isAddress(usdcAddress)) {
    throw new Error("Set USDC_ADDRESS to existing USDC (or MockUSDC)");
  }
  if (!btcOracleAddress || !hre.ethers.isAddress(btcOracleAddress)) {
    throw new Error("Set BTC_ORACLE_ADDRESS (or BTC_ORACLE) to existing BTC/USD price feed");
  }

  console.log("Using existing:");
  console.log("  wBTC:      ", wbtcAddress);
  console.log("  Aave pool: ", aavePoolAddress);
  console.log("  USDC:      ", usdcAddress);
  console.log("  BTC feed:  ", btcOracleAddress);
  console.log("  Bot:       ", botAddress);
  console.log("");

  const KashYieldBtc = await hre.ethers.getContractFactory("KashYieldBtc");
  const kashYieldBtc = await KashYieldBtc.deploy(botAddress);
  await kashYieldBtc.waitForDeployment();
  const kashYieldBtcAddress = await kashYieldBtc.getAddress();
  const kashTokenBtcAddress = await kashYieldBtc.kashTokenBtc();
  console.log("✅ KashYieldBtc:", kashYieldBtcAddress);
  console.log("✅ KashTokenBtc (new):", kashTokenBtcAddress);

  await kashYieldBtc.setWbtcAddress(wbtcAddress);
  await kashYieldBtc.setAavePool(aavePoolAddress);
  await kashYieldBtc.setBtcOracle(btcOracleAddress);
  await kashYieldBtc.setUsdcAddress(usdcAddress);
  console.log("✅ Configured KashYieldBtc (wbtc, aave, oracle, usdc)");

  console.log("\n====================================");
  console.log("📋 KASHYIELDBTC (existing wBTC/Aave/USDC/oracle)");
  console.log("====================================");
  console.log("  KashYieldBtc:  ", kashYieldBtcAddress);
  console.log("  KashTokenBtc:  ", kashTokenBtcAddress);
  console.log("  wBTC (existing): ", wbtcAddress);
  console.log("  Aave (existing):  ", aavePoolAddress);
  console.log("  USDC (existing):  ", usdcAddress);
  console.log("  BTC feed (existing):", btcOracleAddress);
  console.log("====================================\n");

  console.log("Add to frontend/.env.local and bot/.env:");
  console.log(`  KASH_YIELD_BTC_ADDRESS=${kashYieldBtcAddress}`);
  console.log(`  NEXT_PUBLIC_KASH_YIELD_BTC=${kashYieldBtcAddress}`);
  console.log(`  NEXT_PUBLIC_KASH_TOKEN_BTC=${kashTokenBtcAddress}`);
  console.log("");

  const deploymentsDir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(deploymentsDir)) fs.mkdirSync(deploymentsDir, { recursive: true });
  const info = {
    network,
    timestamp: new Date().toISOString(),
    deployer: deployer.address,
    contracts: {
      kashYieldBtc: kashYieldBtcAddress,
      kashTokenBtc: kashTokenBtcAddress,
      wbtcUsed: wbtcAddress,
      aavePoolUsed: aavePoolAddress,
      usdcUsed: usdcAddress,
      btcOracleUsed: btcOracleAddress,
    },
  };
  const filepath = path.join(deploymentsDir, `kashyieldbtc-${network}-${Date.now()}.json`);
  fs.writeFileSync(filepath, JSON.stringify(info, null, 2));
  console.log("💾 Saved:", filepath);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
