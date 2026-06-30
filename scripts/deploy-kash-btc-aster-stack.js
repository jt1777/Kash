/**
 * Deploy the full KashYieldBtc V3 + ExchangeFacade + AsterAdapter stack in ONE run.
 *
 * Resolves the circular dependency (adapter ↔ facade ↔ vault) by precomputing
 * all three CREATE addresses from the deployer's current nonce, then deploying
 * in order:
 *   nonce+0  AsterAdapter   (exchangeFacade = nonce+1)
 *   nonce+1  ExchangeFacade  (adapter = nonce+0, kashYield = nonce+2)
 *   nonce+2  KashYieldBtc    (exchangeFacade = nonce+1)
 *
 * Do NOT send other transactions from the deployer wallet between runs.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-kash-btc-aster-stack.js --network arbitrumOne
 *
 * Required env:
 *   BOT_ADDRESS, WBTC_ADDRESS, USDC_ADDRESS, BTC_ORACLE (or BTC_ORACLE_ADDRESS)
 *   SPOT_DEX_ADDRESS, ASTER_VAULT, ASTER_ACCOUNT_BALANCE, ASTER_BASE_TOKEN
 *
 * Optional:
 *   ASTER_CLEARING_HOUSE, FEE_RECEIVER_ADDRESS, KEEPER_REGISTRY_ADDRESS
 *   CYCLE_DURATION_SECONDS, USER_WINDOW_END, PROCESSING_WINDOW_START
 *   FEE_BPS, MAX_SWAP_SLIPPAGE_BPS, EXCHANGE_NAME (default ASTER)
 */
require("dotenv").config();

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { predictContractAddress, assertDeployedAddress } = require("./lib/predictAddress");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network = hre.network.name;

  const botAddress = process.env.BOT_ADDRESS;
  const wbtcAddress = process.env.WBTC_ADDRESS;
  const usdcAddress = process.env.USDC_ADDRESS;
  const btcOracleAddress = process.env.BTC_ORACLE_ADDRESS || process.env.BTC_ORACLE;
  const spotDexAddress = process.env.SPOT_DEX_ADDRESS || process.env.MOCK_SPOT_DEX_ADDRESS;
  const exchangeName = process.env.EXCHANGE_NAME || "ASTER";
  const keeperRegistry = process.env.KEEPER_REGISTRY_ADDRESS || hre.ethers.ZeroAddress;
  const feeReceiver = process.env.FEE_RECEIVER_ADDRESS || deployer.address;

  const clearingHouse = process.env.ASTER_CLEARING_HOUSE || "0x9E36CB86a159d479cEd94Fa05036f235Ac40E1d5";
  const asterVault = process.env.ASTER_VAULT;
  const accountBalance = process.env.ASTER_ACCOUNT_BALANCE;
  const baseToken = process.env.ASTER_BASE_TOKEN;

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
    ["ASTER_VAULT", asterVault],
    ["ASTER_ACCOUNT_BALANCE", accountBalance],
    ["ASTER_BASE_TOKEN", baseToken],
  ]) {
    if (!addr || !hre.ethers.isAddress(addr)) throw new Error(`Set ${label} in .env`);
  }

  const predictedAdapter = await predictContractAddress(deployer, 0);
  const predictedFacade = await predictContractAddress(deployer, 1);
  const predictedKashYield = await predictContractAddress(deployer, 2);

  console.log("Deploying Kash BTC Aster stack to", network);
  console.log("Deployer:", deployer.address);
  console.log("\nPredicted addresses (from current nonce):");
  console.log("  AsterAdapter:   ", predictedAdapter);
  console.log("  ExchangeFacade: ", predictedFacade);
  console.log("  KashYieldBtc:   ", predictedKashYield);
  console.log("");

  const AsterAdapter = await hre.ethers.getContractFactory("AsterAdapter");
  const adapter = await AsterAdapter.deploy(
    clearingHouse,
    asterVault,
    accountBalance,
    usdcAddress,
    baseToken,
    predictedFacade,
  );
  await adapter.waitForDeployment();
  const adapterAddr = await adapter.getAddress();
  assertDeployedAddress("AsterAdapter", adapterAddr, predictedAdapter);
  console.log("✅ AsterAdapter:", adapterAddr);

  const ExchangeFacade = await hre.ethers.getContractFactory("ExchangeFacade");
  const facade = await ExchangeFacade.deploy(
    botAddress,
    keeperRegistry,
    usdcAddress,
    wbtcAddress,
    predictedKashYield,
    exchangeName,
    adapterAddr,
  );
  await facade.waitForDeployment();
  const facadeAddr = await facade.getAddress();
  assertDeployedAddress("ExchangeFacade", facadeAddr, predictedFacade);
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
  assertDeployedAddress("KashYieldBtc", kashYieldBtcAddress, predictedKashYield);
  const kashTokenBtcAddress = await kashYieldBtc.kashTokenBtc();
  console.log("✅ KashYieldBtc:", kashYieldBtcAddress);
  console.log("✅ KashTokenBtc:", kashTokenBtcAddress);

  console.log("\n====================================");
  console.log("📋 KASH BTC ASTER STACK");
  console.log("====================================");
  console.log("  KashYieldBtc:   ", kashYieldBtcAddress);
  console.log("  KashTokenBtc:   ", kashTokenBtcAddress);
  console.log("  ExchangeFacade: ", facadeAddr);
  console.log("  AsterAdapter:   ", adapterAddr);
  console.log("====================================\n");

  console.log("Add to .env:");
  console.log(`  KASH_YIELD_BTC_ADDRESS=${kashYieldBtcAddress}`);
  console.log(`  KASH_TOKEN_BTC=${kashTokenBtcAddress}`);
  console.log(`  EXCHANGE_FACADE_BTC_ADDRESS=${facadeAddr}`);
  console.log(`  ASTER_ADAPTER_ADDRESS=${adapterAddr}`);
  console.log("\nNext steps:");
  console.log("  1. Deploy UniswapV3Adapter if not done (deploy-uniswap-adapter.js)");
  console.log("  2. Set approveAgent on Aster for the bot wallet");
  console.log("  3. Verify all contracts on Arbiscan");

  const deploymentsDir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(deploymentsDir)) fs.mkdirSync(deploymentsDir, { recursive: true });
  const filepath = path.join(deploymentsDir, `kash-btc-aster-stack-${network}-${Date.now()}.json`);
  fs.writeFileSync(
    filepath,
    JSON.stringify(
      {
        network,
        version: "3.0.0",
        timestamp: new Date().toISOString(),
        deployer: deployer.address,
        contracts: {
          kashYieldBtc: kashYieldBtcAddress,
          kashTokenBtc: kashTokenBtcAddress,
          exchangeFacade: facadeAddr,
          asterAdapter: adapterAddr,
          exchangeName,
          spotDex: spotDexAddress,
          wbtc: wbtcAddress,
          usdc: usdcAddress,
          btcOracle: btcOracleAddress,
          bot: botAddress,
          keeperRegistry,
          feeReceiver,
          aster: { clearingHouse, vault: asterVault, accountBalance, baseToken },
        },
      },
      null,
      2,
    ),
  );
  console.log("💾 Saved:", filepath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
