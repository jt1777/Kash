// scripts/deploy-kashyieldeth.js
// Deploys ExchangeFacade + KashYieldETH V3 when the perp adapter is already deployed.
//
// ⚠️  KASH-ETH V3 + Aster: use the atomic stack script instead (recommended):
//   npx hardhat run scripts/deploy-kash-eth-aster-stack.js --network arbitrumOne
//   npm run deploy:eth-aster
//
// This script remains for HyperliquidAdapter (post-deploy wiring) or re-deploying
// facade + vault when EXCHANGE_ADAPTER_ADDRESS is already set.
//
// Required env:
//   WETH_ADDRESS, USDC_ADDRESS, ETH_ORACLE_ADDRESS (or ETH_ORACLE)
//   BOT_ADDRESS, SPOT_DEX_ADDRESS
//   EXCHANGE_ADAPTER_ADDRESS — HyperliquidAdapter (must exist before this script)
//   EXCHANGE_NAME — must be "HL" (Aster uses deploy-kash-eth-aster-stack.js)
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

  console.log("Deploying KashYieldETH V3 to", network);
  console.log("Deployer:", deployer.address);

  const botAddress = process.env.BOT_ADDRESS;
  const wethAddress = process.env.WETH_ADDRESS;
  const usdcAddress = process.env.USDC_ADDRESS;
  const ethOracleAddress = process.env.ETH_ORACLE_ADDRESS || process.env.ETH_ORACLE;
  const spotDexAddress = process.env.SPOT_DEX_ADDRESS || process.env.MOCK_SPOT_DEX_ADDRESS;
  const adapterAddress = process.env.EXCHANGE_ADAPTER_ADDRESS;
  const exchangeName = process.env.EXCHANGE_NAME || "HL";

  if (exchangeName.toUpperCase() === "ASTER") {
    throw new Error(
      "Aster V3 must use the atomic stack deploy:\n" +
        "  npx hardhat run scripts/deploy-kash-eth-aster-stack.js --network arbitrumOne\n" +
        "  npm run deploy:eth-aster",
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
    ["WETH_ADDRESS", wethAddress],
    ["USDC_ADDRESS", usdcAddress],
    ["ETH_ORACLE", ethOracleAddress],
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
  console.log("  2. KashYieldETH");
  console.log("  Bot:          ", botAddress);
  console.log("  Adapter:      ", adapterAddress, `(${exchangeName})`);
  console.log("  Spot DEX:     ", spotDexAddress);
  console.log("  ETH oracle:   ", ethOracleAddress);
  console.log("  Fee receiver: ", feeReceiver);
  console.log("");

  const ExchangeFacade = await hre.ethers.getContractFactory("ExchangeFacade");
  const facade = await ExchangeFacade.deploy(
    botAddress,
    keeperRegistry,
    usdcAddress,
    wethAddress,
    predictedKashYield,
    exchangeName,
    adapterAddress,
  );
  await facade.waitForDeployment();
  const facadeAddr = await facade.getAddress();
  console.log("✅ ExchangeFacade:", facadeAddr);

  const KashYieldETH = await hre.ethers.getContractFactory("KashYieldETH");
  const kashYieldEth = await KashYieldETH.deploy(
    botAddress,
    wethAddress,
    usdcAddress,
    facadeAddr,
    spotDexAddress,
    ethOracleAddress,
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
  await kashYieldEth.waitForDeployment();
  const kashYieldEthAddress = await kashYieldEth.getAddress();

  if (kashYieldEthAddress.toLowerCase() !== predictedKashYield.toLowerCase()) {
    throw new Error(`Address prediction failed: got ${kashYieldEthAddress}, expected ${predictedKashYield}`);
  }

  const kashTokenEthAddress = await kashYieldEth.kashTokenEth();
  console.log("✅ KashYieldETH:", kashYieldEthAddress);
  console.log("✅ KashTokenEth:", kashTokenEthAddress);

  console.log("\n====================================");
  console.log("📋 KASHYIELDETH V3 (ownerless)");
  console.log("====================================");
  console.log("  KashYieldETH:   ", kashYieldEthAddress);
  console.log("  KashTokenEth:   ", kashTokenEthAddress);
  console.log("  ExchangeFacade: ", facadeAddr);
  console.log("  Perp adapter:   ", adapterAddress);
  console.log("====================================\n");

  console.log("Add to .env:");
  console.log(`  KASH_YIELD_ETH_ADDRESS=${kashYieldEthAddress}`);
  console.log(`  KASH_TOKEN_ETH=${kashTokenEthAddress}`);
  console.log(`  EXCHANGE_FACADE_ETH_ADDRESS=${facadeAddr}`);
  console.log("\nNext: verify on Arbiscan, publish deployer key.");

  const deploymentsDir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(deploymentsDir)) fs.mkdirSync(deploymentsDir, { recursive: true });
  const info = {
    network,
    version: "3.0.0",
    timestamp: new Date().toISOString(),
    deployer: deployer.address,
    contracts: {
      kashYieldEth: kashYieldEthAddress,
      kashTokenEth: kashTokenEthAddress,
      exchangeFacade: facadeAddr,
      perpAdapter: adapterAddress,
      exchangeName,
      spotDex: spotDexAddress,
      weth: wethAddress,
      usdc: usdcAddress,
      ethOracle: ethOracleAddress,
      bot: botAddress,
      keeperRegistry,
      feeReceiver,
    },
  };
  const filepath = path.join(deploymentsDir, `kashyieldeth-v3-${network}-${Date.now()}.json`);
  fs.writeFileSync(filepath, JSON.stringify(info, null, 2));
  console.log("💾 Saved:", filepath);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
