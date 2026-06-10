// scripts/deploy-kashyieldbtc.js
// Deploys only KashYieldBtc (and its built-in KashTokenBtc). Uses existing wBTC, Aave pool, USDC, and BTC oracle from env.
// Uses Arbitrum One protocol/token addresses from env.
//
// Usage:
//   npx hardhat run scripts/deploy-kashyieldbtc.js --network arbitrumOne
//
// Env (required for configuration after deploy). Use any of the listed names.
//   wBTC:    WBTC_ADDRESS
//   Aave:    AAVE_POOL_ADDRESS (for scripts only; contract uses hardcoded Arbitrum One pool)
//   USDC:    USDC_ADDRESS
//   Oracle:  BTC_ORACLE_ADDRESS or BTC_ORACLE
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

  const wbtcAddress = process.env.WBTC_ADDRESS;
  const usdcAddress = process.env.USDC_ADDRESS;
  const btcOracleAddress = process.env.BTC_ORACLE_ADDRESS || process.env.BTC_ORACLE;

  if (!wbtcAddress || !hre.ethers.isAddress(wbtcAddress)) {
    throw new Error("Set WBTC_ADDRESS in .env to existing wBTC contract");
  }
  if (!usdcAddress || !hre.ethers.isAddress(usdcAddress)) {
    throw new Error("Set USDC_ADDRESS in .env to existing USDC");
  }
  if (!btcOracleAddress || !hre.ethers.isAddress(btcOracleAddress)) {
    throw new Error("Set BTC_ORACLE_ADDRESS (or BTC_ORACLE) in .env to existing BTC/USD price feed");
  }

  // NOTE: aavePoolAddress is now immutable and hardcoded to Arbitrum One mainnet (0x794a...)
  // in the constructor. AAVE_POOL_ADDRESS env var is no longer used for deployment.
  console.log("Deploying with:");
  console.log("  wBTC:     ", wbtcAddress);
  console.log("  USDC:     ", usdcAddress);
  console.log("  BTC feed: ", btcOracleAddress);
  console.log("  Bot:      ", botAddress);
  console.log("  Aave:      0x794a61358D6845594F94dc1DB02A252b5b4814aD (hardcoded mainnet)");
  console.log("");

  const KashYieldBtc = await hre.ethers.getContractFactory("KashYieldBtc");
  const kashYieldBtc = await KashYieldBtc.deploy(botAddress, wbtcAddress, usdcAddress);
  await kashYieldBtc.waitForDeployment();
  const kashYieldBtcAddress = await kashYieldBtc.getAddress();
  const kashTokenBtcAddress = await kashYieldBtc.kashTokenBtc();
  console.log("✅ KashYieldBtc:", kashYieldBtcAddress);
  console.log("✅ KashTokenBtc (new):", kashTokenBtcAddress);

  // wbtcAddress, usdcAddress, aavePoolAddress all set immutably in constructor
  await kashYieldBtc.setBtcOracle(btcOracleAddress);
  console.log("✅ Configured KashYieldBtc (btc oracle)");

  const spotDexAddress = process.env.MOCK_SPOT_DEX_ADDRESS || process.env.SPOT_DEX_ADDRESS || "";
  if (spotDexAddress && hre.ethers.isAddress(spotDexAddress)) {
    await kashYieldBtc.setSpotDex(spotDexAddress);
    console.log("✅ setSpotDex →", spotDexAddress);
  }

  console.log("\n====================================");
  console.log("📋 KASHYIELDBTC (existing wBTC/Aave/USDC/oracle)");
  console.log("====================================");
  console.log("  KashYieldBtc:  ", kashYieldBtcAddress);
  console.log("  KashTokenBtc:  ", kashTokenBtcAddress);
  console.log("  wBTC:     ", wbtcAddress);
  console.log("  Aave:      0x794a61358D6845594F94dc1DB02A252b5b4814aD (hardcoded mainnet)");
  console.log("  USDC:     ", usdcAddress);
  console.log("  BTC feed: ", btcOracleAddress);
  console.log("====================================\n");

  console.log("Add to .env, frontend/.env.local, and private kash-ops repo .env:");
  console.log(`  KASH_YIELD_BTC_ADDRESS=${kashYieldBtcAddress}`);
  console.log(`  KASH_TOKEN_BTC=${kashTokenBtcAddress}`);
  console.log("");
  console.log("Next steps:");
  console.log("  1. Deploy HyperliquidAdapter + ExchangeFacade (this repo deploy scripts)");
  console.log("  2. Wire facade, spot DEX, HL bootstrap — see kash-ops docs/DEPLOYMENT.md");
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
      aavePoolUsed: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
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
