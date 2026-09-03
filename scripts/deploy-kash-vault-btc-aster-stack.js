/**
 * Deploy KashVaultBtc (4626/7540) + libraries + ExchangeFacade + AsterAdapter.
 *
 * Nonce layout from current deployer nonce:
 *   +0 NavLib  +1 OpsLib  +2 BatchLib
 *   +3 AsterAdapter  +4 ExchangeFacade  +5 KashVaultBtc
 *
 * Usage:
 *   npx hardhat run scripts/deploy-kash-vault-btc-aster-stack.js --network arbitrumOne
 *
 * Required env: BOT_ADDRESS, OWNER_ADDRESS, WBTC_ADDRESS, USDC_ADDRESS,
 *   BTC_ORACLE, SPOT_DEX_ADDRESS, ASTER_VAULT, ASTER_ACCOUNT_BALANCE, ASTER_BASE_TOKEN
 * Optional: WATCHER_ADDRESS, AAVE_A_TOKEN, AAVE_VARIABLE_DEBT_USDC,
 *   ASTER_CLEARING_HOUSE, FEE_BPS (default 5)
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
  const ownerAddress = process.env.OWNER_ADDRESS || deployer.address;
  const watcherAddress = process.env.WATCHER_ADDRESS || hre.ethers.ZeroAddress;
  const wbtcAddress = process.env.WBTC_ADDRESS;
  const usdcAddress = process.env.USDC_ADDRESS;
  const btcOracleAddress = process.env.BTC_ORACLE_ADDRESS || process.env.BTC_ORACLE;
  const spotDexAddress = process.env.SPOT_DEX_ADDRESS || process.env.MOCK_SPOT_DEX_ADDRESS;
  const exchangeName = process.env.EXCHANGE_NAME || "ASTER";
  const keeperRegistry = process.env.KEEPER_REGISTRY_ADDRESS || hre.ethers.ZeroAddress;
  const feeReceiver = process.env.FEE_RECEIVER_ADDRESS || deployer.address;
  const aavePool = process.env.AAVE_POOL || "0x794a61358D6845594F94dc1DB02A252b5b4814aD";
  const aToken = process.env.AAVE_A_TOKEN || hre.ethers.ZeroAddress;
  const variableDebtUsdc = process.env.AAVE_VARIABLE_DEBT_USDC || hre.ethers.ZeroAddress;

  const clearingHouse = process.env.ASTER_CLEARING_HOUSE || "0x9E36CB86a159d479cEd94Fa05036f235Ac40E1d5";
  const asterVault = process.env.ASTER_VAULT;
  const accountBalance = process.env.ASTER_ACCOUNT_BALANCE;
  const baseToken = process.env.ASTER_BASE_TOKEN;

  const cycleDuration = BigInt(process.env.CYCLE_DURATION_SECONDS || "86400");
  const userWindowEnd = BigInt(process.env.USER_WINDOW_END || "85500");
  const processingWindowStart = BigInt(process.env.PROCESSING_WINDOW_START || "85500");
  const feeBps = BigInt(process.env.FEE_BPS || "5");
  const maxSwapSlippageBps = BigInt(process.env.MAX_SWAP_SLIPPAGE_BPS || "50");
  const redeemPayoutBufferBps = BigInt(process.env.REDEEM_PAYOUT_BUFFER_BPS || "50");

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

  const predictedNav = await predictContractAddress(deployer, 0);
  const predictedOps = await predictContractAddress(deployer, 1);
  const predictedBatch = await predictContractAddress(deployer, 2);
  const predictedAdapter = await predictContractAddress(deployer, 3);
  const predictedFacade = await predictContractAddress(deployer, 4);
  const predictedVault = await predictContractAddress(deployer, 5);

  console.log("Deploying KashVaultBtc Aster stack to", network);
  console.log("Predicted:");
  console.log("  NavLib        ", predictedNav);
  console.log("  OpsLib        ", predictedOps);
  console.log("  BatchLib      ", predictedBatch);
  console.log("  AsterAdapter  ", predictedAdapter);
  console.log("  ExchangeFacade", predictedFacade);
  console.log("  KashVaultBtc  ", predictedVault);

  const nav = await (await hre.ethers.getContractFactory("KashVaultNavLib")).deploy();
  await nav.waitForDeployment();
  assertDeployedAddress("KashVaultNavLib", await nav.getAddress(), predictedNav);

  const ops = await (await hre.ethers.getContractFactory("KashVaultOpsLib")).deploy();
  await ops.waitForDeployment();
  assertDeployedAddress("KashVaultOpsLib", await ops.getAddress(), predictedOps);

  const batch = await (await hre.ethers.getContractFactory("KashVaultBatchLib")).deploy();
  await batch.waitForDeployment();
  assertDeployedAddress("KashVaultBatchLib", await batch.getAddress(), predictedBatch);

  const libraries = {
    KashVaultNavLib: await nav.getAddress(),
    KashVaultOpsLib: await ops.getAddress(),
    KashVaultBatchLib: await batch.getAddress(),
  };

  const adapter = await (await hre.ethers.getContractFactory("AsterAdapter")).deploy(
    clearingHouse,
    asterVault,
    accountBalance,
    usdcAddress,
    baseToken,
    predictedFacade,
    predictedVault,
    8,
  );
  await adapter.waitForDeployment();
  assertDeployedAddress("AsterAdapter", await adapter.getAddress(), predictedAdapter);

  const facade = await (await hre.ethers.getContractFactory("ExchangeFacade")).deploy(
    botAddress,
    keeperRegistry,
    usdcAddress,
    wbtcAddress,
    predictedVault,
    exchangeName,
    await adapter.getAddress(),
  );
  await facade.waitForDeployment();
  assertDeployedAddress("ExchangeFacade", await facade.getAddress(), predictedFacade);

  const vault = await (await hre.ethers.getContractFactory("KashVaultBtc", { libraries })).deploy({
    owner: ownerAddress,
    bot: botAddress,
    watcher: watcherAddress,
    asset: wbtcAddress,
    usdc: usdcAddress,
    exchangeFacade: await facade.getAddress(),
    spotDex: spotDexAddress,
    assetOracle: btcOracleAddress,
    keeperRegistry,
    feeReceiver,
    aavePool,
    aToken,
    variableDebtUsdc,
    asterClearingHouse: clearingHouse,
    cycleDurationSeconds: cycleDuration,
    userWindowEnd,
    processingWindowStart,
    maxSwapSlippageBps,
    feeBps,
    maxDepositUsers: 10_000n,
    maxRedeemUsers: 10_000n,
    redeemPayoutBufferBps,
  });
  await vault.waitForDeployment();
  assertDeployedAddress("KashVaultBtc", await vault.getAddress(), predictedVault);

  const vaultAddr = await vault.getAddress();
  console.log("\n====================================");
  console.log("KASH VAULT BTC ASTER STACK");
  console.log("  KashVaultBtc (share token):", vaultAddr);
  console.log("  ExchangeFacade:            ", await facade.getAddress());
  console.log("  AsterAdapter:              ", await adapter.getAddress());
  console.log("====================================\n");
  console.log(`  KASH_YIELD_BTC_ADDRESS=${vaultAddr}`);
  console.log(`  KASH_TOKEN_BTC=${vaultAddr}`);
  console.log(`  NEXT_PUBLIC_KASH_YIELD_BTC_ADDRESS=${vaultAddr}`);
  console.log(`  NEXT_PUBLIC_KASH_TOKEN_BTC=${vaultAddr}`);

  const deploymentsDir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(deploymentsDir)) fs.mkdirSync(deploymentsDir, { recursive: true });
  const filepath = path.join(deploymentsDir, `kash-vault-btc-aster-${network}-${Date.now()}.json`);
  fs.writeFileSync(
    filepath,
    JSON.stringify(
      {
        network,
        version: "2.0.0",
        timestamp: new Date().toISOString(),
        deployer: deployer.address,
        contracts: {
          kashVaultBtc: vaultAddr,
          libraries,
          exchangeFacade: await facade.getAddress(),
          asterAdapter: await adapter.getAddress(),
          owner: ownerAddress,
          bot: botAddress,
          watcher: watcherAddress,
        },
      },
      null,
      2,
    ),
  );
  console.log("Saved:", filepath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
