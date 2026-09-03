/**
 * Deploy KashVaultEth (4626/7540) + libraries + ExchangeFacade + AsterAdapter.
 *
 * Nonce layout from current deployer nonce:
 *   +0 NavLib  +1 OpsLib  +2 BatchLib
 *   +3 AsterAdapter  +4 ExchangeFacade  +5 KashVaultEth
 *
 * Usage:
 *   npx hardhat run scripts/deploy-kash-vault-eth-aster-stack.js --network arbitrumOne
 *
 * Required env: BOT_ADDRESS, OWNER_ADDRESS, WETH_ADDRESS, USDC_ADDRESS,
 *   ETH_ORACLE, SPOT_DEX_ADDRESS, ASTER_VAULT, ASTER_ACCOUNT_BALANCE, ASTER_BASE_TOKEN
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
  const wethAddress = process.env.WETH_ADDRESS;
  const usdcAddress = process.env.USDC_ADDRESS;
  const ethOracleAddress = process.env.ETH_ORACLE_ADDRESS || process.env.ETH_ORACLE;
  const spotDexAddress = process.env.SPOT_DEX_ADDRESS;
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

  const predictedNav = await predictContractAddress(deployer, 0);
  const predictedOps = await predictContractAddress(deployer, 1);
  const predictedBatch = await predictContractAddress(deployer, 2);
  const predictedAdapter = await predictContractAddress(deployer, 3);
  const predictedFacade = await predictContractAddress(deployer, 4);
  const predictedVault = await predictContractAddress(deployer, 5);

  console.log("Deploying KashVaultEth Aster stack to", network);
  console.log("Predicted:");
  console.log("  NavLib        ", predictedNav);
  console.log("  OpsLib        ", predictedOps);
  console.log("  BatchLib      ", predictedBatch);
  console.log("  AsterAdapter  ", predictedAdapter);
  console.log("  ExchangeFacade", predictedFacade);
  console.log("  KashVaultEth  ", predictedVault);

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
    18,
  );
  await adapter.waitForDeployment();
  assertDeployedAddress("AsterAdapter", await adapter.getAddress(), predictedAdapter);

  const facade = await (await hre.ethers.getContractFactory("ExchangeFacade")).deploy(
    botAddress,
    keeperRegistry,
    usdcAddress,
    wethAddress,
    predictedVault,
    exchangeName,
    await adapter.getAddress(),
  );
  await facade.waitForDeployment();
  assertDeployedAddress("ExchangeFacade", await facade.getAddress(), predictedFacade);

  const vault = await (await hre.ethers.getContractFactory("KashVaultEth", { libraries })).deploy({
    owner: ownerAddress,
    bot: botAddress,
    watcher: watcherAddress,
    asset: wethAddress,
    usdc: usdcAddress,
    exchangeFacade: await facade.getAddress(),
    spotDex: spotDexAddress,
    assetOracle: ethOracleAddress,
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
  assertDeployedAddress("KashVaultEth", await vault.getAddress(), predictedVault);

  const vaultAddr = await vault.getAddress();
  console.log("\n====================================");
  console.log("KASH VAULT ETH ASTER STACK");
  console.log("  KashVaultEth (share token):", vaultAddr);
  console.log("  ExchangeFacade:            ", await facade.getAddress());
  console.log("  AsterAdapter:              ", await adapter.getAddress());
  console.log("====================================\n");
  console.log(`  KASH_YIELD_ETH_ADDRESS=${vaultAddr}`);
  console.log(`  KASH_TOKEN_ETH=${vaultAddr}`);
  console.log(`  NEXT_PUBLIC_KASH_YIELD_ETH_ADDRESS=${vaultAddr}`);
  console.log(`  NEXT_PUBLIC_KASH_TOKEN_ETH=${vaultAddr}`);

  const deploymentsDir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(deploymentsDir)) fs.mkdirSync(deploymentsDir, { recursive: true });
  const filepath = path.join(deploymentsDir, `kash-vault-eth-aster-${network}-${Date.now()}.json`);
  fs.writeFileSync(
    filepath,
    JSON.stringify(
      {
        network,
        version: "2.0.0",
        timestamp: new Date().toISOString(),
        deployer: deployer.address,
        contracts: {
          kashVaultEth: vaultAddr,
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
