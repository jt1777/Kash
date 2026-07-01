/**
 * Deploy the full KashYieldETH V3 + ExchangeFacade + AsterAdapter stack in ONE run.
 *
 * Resolves the circular dependency (adapter ↔ facade ↔ vault) by precomputing
 * all three CREATE addresses from the deployer's current nonce, then deploying
 * in order:
 *   nonce+0  AsterAdapter   (exchangeFacade = nonce+1)
 *   nonce+1  ExchangeFacade  (adapter = nonce+0, kashYield = nonce+2)
 *   nonce+2  KashYieldETH    (exchangeFacade = nonce+1)
 *
 * Do NOT send other transactions from the deployer wallet between runs.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-kash-eth-aster-stack.js --network arbitrumOne
 *
 * Required env:
 *   BOT_ADDRESS, WETH_ADDRESS, USDC_ADDRESS, ETH_ORACLE (or ETH_ORACLE_ADDRESS)
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
  const wethAddress = process.env.WETH_ADDRESS;
  const usdcAddress = process.env.USDC_ADDRESS;
  const ethOracleAddress = process.env.ETH_ORACLE_ADDRESS || process.env.ETH_ORACLE;
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
    ["WETH_ADDRESS", wethAddress],
    ["USDC_ADDRESS", usdcAddress],
    ["ETH_ORACLE", ethOracleAddress],
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

  console.log("Deploying Kash ETH Aster stack to", network);
  console.log("Deployer:", deployer.address);
  console.log("\nPredicted addresses (from current nonce):");
  console.log("  AsterAdapter:   ", predictedAdapter);
  console.log("  ExchangeFacade: ", predictedFacade);
  console.log("  KashYieldETH:   ", predictedKashYield);
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
    wethAddress,
    predictedKashYield,
    exchangeName,
    adapterAddr,
  );
  await facade.waitForDeployment();
  const facadeAddr = await facade.getAddress();
  assertDeployedAddress("ExchangeFacade", facadeAddr, predictedFacade);
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
  assertDeployedAddress("KashYieldETH", kashYieldEthAddress, predictedKashYield);
  const kashTokenEthAddress = await kashYieldEth.kashTokenEth();
  console.log("✅ KashYieldETH:", kashYieldEthAddress);
  console.log("✅ KashTokenEth:", kashTokenEthAddress);

  console.log("\n====================================");
  console.log("📋 KASH ETH ASTER STACK");
  console.log("====================================");
  console.log("  KashYieldETH:   ", kashYieldEthAddress);
  console.log("  KashTokenEth:   ", kashTokenEthAddress);
  console.log("  ExchangeFacade: ", facadeAddr);
  console.log("  AsterAdapter:   ", adapterAddr);
  console.log("====================================\n");

  console.log("Add to .env:");
  console.log(`  KASH_YIELD_ETH_ADDRESS=${kashYieldEthAddress}`);
  console.log(`  KASH_TOKEN_ETH=${kashTokenEthAddress}`);
  console.log(`  EXCHANGE_FACADE_ETH_ADDRESS=${facadeAddr}`);
  console.log(`  ASTER_ADAPTER_ADDRESS_ETH=${adapterAddr}`);
  console.log("\nNext steps:");
  console.log("  1. Deploy UniswapV3Adapter if not done (deploy-uniswap-adapter.js)");
  console.log("  2. Set approveAgent on Aster for the bot wallet");
  console.log("  3. Verify all contracts on Arbiscan");

  const deploymentsDir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(deploymentsDir)) fs.mkdirSync(deploymentsDir, { recursive: true });
  const filepath = path.join(deploymentsDir, `kash-eth-aster-stack-${network}-${Date.now()}.json`);
  fs.writeFileSync(
    filepath,
    JSON.stringify(
      {
        network,
        version: "3.0.0",
        timestamp: new Date().toISOString(),
        deployer: deployer.address,
        contracts: {
          kashYieldEth: kashYieldEthAddress,
          kashTokenEth: kashTokenEthAddress,
          exchangeFacade: facadeAddr,
          asterAdapter: adapterAddr,
          exchangeName,
          spotDex: spotDexAddress,
          weth: wethAddress,
          usdc: usdcAddress,
          ethOracle: ethOracleAddress,
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
