// scripts/deploy-kashyieldbtc.js
// Deploys ExchangeFacade + KashYieldBtc when the perp adapter is already deployed.
//
// ⚠️  KASH-BTC V3 + Aster: use the atomic stack script instead (recommended):
//   npx hardhat run scripts/deploy-kash-btc-aster-stack.js --network arbitrumOne
//   npm run deploy:btc-aster
//
// This script remains for HyperliquidAdapter (post-deploy wiring) or re-deploying
// facade + vault when EXCHANGE_ADAPTER_ADDRESS is already set.
//
// Required env:
//   WBTC_ADDRESS, USDC_ADDRESS, BTC_ORACLE_ADDRESS (or BTC_ORACLE)
//   BOT_ADDRESS, SPOT_DEX_ADDRESS
//   EXCHANGE_ADAPTER_ADDRESS — HyperliquidAdapter (must exist before this script)
//   EXCHANGE_NAME — must be "HL" (Aster uses deploy-kash-btc-aster-stack.js)
//
// Optional env:
//   KEEPER_REGISTRY_ADDRESS — Chainlink Automation registry (default: zero)
//   CYCLE_DURATION_SECONDS (default: 86400)
//   USER_WINDOW_END (default: 85500)
//   PROCESSING_WINDOW_START (default: 85500)
//   FEE_BPS (default: 3), MAX_SWAP_SLIPPAGE_BPS (default: 100)

require("dotenv").config();
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const { predictContractAddress } = require("./lib/predictAddress");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network = hre.network.name;

  console.log("Deploying KashYieldBtc V3 to", network);
  console.log("Deployer:", deployer.address);

  const botAddress = process.env.BOT_ADDRESS;
  const wbtcAddress = process.env.WBTC_ADDRESS;
  const usdcAddress = process.env.USDC_ADDRESS;
  const btcOracleAddress = process.env.BTC_ORACLE_ADDRESS || process.env.BTC_ORACLE;
  const spotDexAddress = process.env.SPOT_DEX_ADDRESS || process.env.MOCK_SPOT_DEX_ADDRESS;
  const adapterAddress = process.env.EXCHANGE_ADAPTER_ADDRESS;
  const exchangeName = process.env.EXCHANGE_NAME || "HL";

  if (exchangeName.toUpperCase() === "ASTER") {
    throw new Error(
      "Aster V3 must use the atomic stack deploy:\n" +
        "  npx hardhat run scripts/deploy-kash-btc-aster-stack.js --network arbitrumOne\n" +
        "  npm run deploy:btc-aster",
    );
  }

  const keeperRegistry = process.env.KEEPER_REGISTRY_ADDRESS || hre.ethers.ZeroAddress;
  const feeReceiver = process.env.FEE_RECEIVER_ADDRESS || deployer.address;

  const cycleDuration = BigInt(process.env.CYCLE_DURATION_SECONDS || "86400");
  const userWindowEnd = BigInt(process.env.USER_WINDOW_END || "85500");
  const processingWindowStart = BigInt(process.env.PROCESSING_WINDOW_START || "85500");
  const feeBps = BigInt(process.env.FEE_BPS || "3");
  const maxSwapSlippageBps = BigInt(process.env.MAX_SWAP_SLIPPAGE_BPS || "100");

  for (const [label, addr] of [
    ["BOT_ADDRESS", botAddress],
    ["WBTC_ADDRESS", wbtcAddress],
    ["USDC_ADDRESS", usdcAddress],
    ["BTC_ORACLE", btcOracleAddress],
    ["SPOT_DEX_ADDRESS", spotDexAddress],
    ["EXCHANGE_ADAPTER_ADDRESS", adapterAddress],
  ]) {
    if (!addr || !hre.ethers.isAddress(addr)) {
      throw new Error(`Set ${label} in .env`);
    }
  }

  const predictedKashYield = await predictContractAddress(deployer, 1);

  console.log("\nDeploy order (HL adapter already deployed):");
  console.log("  1. ExchangeFacade → predicted KashYield:", predictedKashYield);
  console.log("  2. KashYieldBtc");
  console.log("  Bot:          ", botAddress);
  console.log("  Adapter:      ", adapterAddress, `(${exchangeName})`);
  console.log("  Spot DEX:     ", spotDexAddress);
  console.log("  BTC oracle:   ", btcOracleAddress);
  console.log("  Fee receiver: ", feeReceiver);
  console.log("");

  const ExchangeFacade = await hre.ethers.getContractFactory("ExchangeFacade");
  const facade = await ExchangeFacade.deploy(
    botAddress,
    keeperRegistry,
    usdcAddress,
    wbtcAddress,
    predictedKashYield,
    exchangeName,
    adapterAddress,
  );
  await facade.waitForDeployment();
  const facadeAddr = await facade.getAddress();
  console.log("✅ ExchangeFacade:", facadeAddr);

  const KashYieldBtc = await hre.ethers.getContractFactory("KashYieldBtc");
  const kashYieldBtc = await KashYieldBtc.deploy(
    botAddress,
    wbtcAddress,
    usdcAddress,
    facadeAddr,
    spotDexAddress,
    btcOracleAddress,
    keeperRegistry,
    feeReceiver,
    cycleDuration,
    userWindowEnd,
    processingWindowStart,
    maxSwapSlippageBps,
    feeBps,
    10_000n,
    10_000n,
  );
  await kashYieldBtc.waitForDeployment();
  const kashYieldBtcAddress = await kashYieldBtc.getAddress();

  if (kashYieldBtcAddress.toLowerCase() !== predictedKashYield.toLowerCase()) {
    throw new Error(`Address prediction failed: got ${kashYieldBtcAddress}, expected ${predictedKashYield}`);
  }

  const kashTokenBtcAddress = await kashYieldBtc.kashTokenBtc();
  console.log("✅ KashYieldBtc:", kashYieldBtcAddress);
  console.log("✅ KashTokenBtc:", kashTokenBtcAddress);

  console.log("\n====================================");
  console.log("📋 KASHYIELDBTC V3 (ownerless)");
  console.log("====================================");
  console.log("  KashYieldBtc:   ", kashYieldBtcAddress);
  console.log("  KashTokenBtc:   ", kashTokenBtcAddress);
  console.log("  ExchangeFacade: ", facadeAddr);
  console.log("  Perp adapter:   ", adapterAddress);
  console.log("====================================\n");

  console.log("Add to .env:");
  console.log(`  KASH_YIELD_BTC_ADDRESS=${kashYieldBtcAddress}`);
  console.log(`  KASH_TOKEN_BTC=${kashTokenBtcAddress}`);
  console.log(`  EXCHANGE_FACADE_BTC_ADDRESS=${facadeAddr}`);
  console.log("\nNext: set approveAgent on Aster to bot wallet, verify on Arbiscan, publish deployer key.");

  const deploymentsDir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(deploymentsDir)) fs.mkdirSync(deploymentsDir, { recursive: true });
  const info = {
    network,
    version: "3.0.0",
    timestamp: new Date().toISOString(),
    deployer: deployer.address,
    contracts: {
      kashYieldBtc: kashYieldBtcAddress,
      kashTokenBtc: kashTokenBtcAddress,
      exchangeFacade: facadeAddr,
      perpAdapter: adapterAddress,
      exchangeName,
      spotDex: spotDexAddress,
      wbtc: wbtcAddress,
      usdc: usdcAddress,
      btcOracle: btcOracleAddress,
      bot: botAddress,
      keeperRegistry,
      feeReceiver,
    },
  };
  const filepath = path.join(deploymentsDir, `kashyieldbtc-v3-${network}-${Date.now()}.json`);
  fs.writeFileSync(filepath, JSON.stringify(info, null, 2));
  console.log("💾 Saved:", filepath);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
