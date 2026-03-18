// scripts/deploy-arbitrum-sepolia.js
// Deploys KashYieldETH (ETH product) to Arbitrum Sepolia. Uses built-in Sepolia addresses (Aave, tokens, oracles).
// No mocks; intended for testnet with real protocols.
//
// Prerequisites:
//   - .env with PRIVATE_KEY and optionally ARBITRUM_SEPOLIA_RPC_URL, HYPERLIQUID_ADDRESS
//   - Funded deployer wallet on Arbitrum Sepolia
//
// Usage:
//   npx hardhat run scripts/deploy-arbitrum-sepolia.js --network arbitrumSepolia

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const network = hre.network.name;
  if (network !== "arbitrumSepolia") {
    console.warn(`⚠️  This script is intended for Arbitrum Sepolia. You are on: ${network}`);
  }

  const signers = await hre.ethers.getSigners();
  const deployer = signers[0];
  if (!deployer) {
    throw new Error(
      "No deployer account. Set PRIVATE_KEY in the project root .env file (not in scripts/). " +
      "Run this from repo root: npx hardhat run scripts/deploy-arbitrum-sepolia.js --network arbitrumSepolia"
    );
  }
  console.log("Deploying to", network);
  console.log("Deployer:", deployer.address);
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Balance:", hre.ethers.formatEther(balance), "ETH\n");

  if (balance === 0n) {
    throw new Error("Deployer balance is 0. Get testnet ETH from Arbitrum Sepolia faucet.");
  }

  // ============================================
  // 1. Deploy KashYieldETH (constructor: botAddress)
  // ============================================
  const botAddress = process.env.BOT_ADDRESS || deployer.address;

  // Optional overrides — provide these in .env when testing with mock contracts.
  // If not set, the contract keeps its hardcoded built-in addresses (real Aave V3 / real USDC).
  const aavePoolOverride = process.env.AAVE_POOL_ADDRESS || process.env.MOCK_AAVE_ADDRESS || "";
  const usdcOverride     = process.env.USDC_ADDRESS      || process.env.MOCK_USDC_ADDRESS  || "";
  const wethOverride     = process.env.WETH_ADDRESS      || process.env.MOCK_WETH_ADDRESS   || "";

  console.log("Deploying KashYieldETH (botAddress:", botAddress, ")...");
  const KashYieldETH = await hre.ethers.getContractFactory("KashYieldETH");
  const kashYieldEth = await KashYieldETH.deploy(botAddress);
  await kashYieldEth.waitForDeployment();

  const kashYieldEthAddress = await kashYieldEth.getAddress();
  const kashTokenEthAddress = await kashYieldEth.kashTokenEth();
  console.log("✅ KashYieldETH:", kashYieldEthAddress);
  console.log("✅ KashTokenEth:", kashTokenEthAddress);

  // Apply address overrides if provided
  if (aavePoolOverride && hre.ethers.isAddress(aavePoolOverride)) {
    await (await kashYieldEth.setAavePool(aavePoolOverride)).wait();
    console.log("✅ setAavePool →", aavePoolOverride);
  }
  if (usdcOverride && hre.ethers.isAddress(usdcOverride)) {
    await (await kashYieldEth.setUsdcAddress(usdcOverride)).wait();
    console.log("✅ setUsdcAddress →", usdcOverride);
  }
  if (wethOverride && hre.ethers.isAddress(wethOverride)) {
    await (await kashYieldEth.setWethAddress(wethOverride)).wait();
    console.log("✅ setWethAddress →", wethOverride);
  }

  // ============================================
  // 2. Optional: register HyperliquidAdapter (first-time bypass — immediate, no timelock)
  // ============================================
  // Set HL_ADAPTER_ADDRESS_ETH to the deployed HyperliquidAdapter address to auto-register here.
  // Do NOT use HYPERLIQUID_ADDRESS here — that points to MockHL, not the adapter.
  // Deploy the adapter first: npx hardhat run scripts/deploy-hyperliquid-adapter.js
  const hyperliquidAddress = process.env.HL_ADAPTER_ADDRESS_ETH || "";
  if (hyperliquidAddress && hre.ethers.isAddress(hyperliquidAddress)) {
    const tx = await kashYieldEth.setHyperliquid(hyperliquidAddress);
    await tx.wait();
    const readyAt = await kashYieldEth.adapterReadyAt("HL");
    const registered = await kashYieldEth.perpExchanges("HL");
    if (registered !== hre.ethers.ZeroAddress && BigInt(readyAt.toString()) === 0n) {
      console.log("✅ HyperliquidAdapter registered immediately (first-time bypass):", registered);
      console.log("   Run scripts/setActivePerpExchange.js (EXCHANGE_NAME=HL) to activate.");
    } else {
      console.log("✅ HyperliquidAdapter proposed. Timelock expires:", new Date(Number(readyAt) * 1000).toISOString());
      console.log("   Step 2: Run scripts/confirmPerpExchange.js (EXCHANGE_NAME=HL) after 48 hours.");
      console.log("   Step 3: Run scripts/setActivePerpExchange.js (EXCHANGE_NAME=HL) to activate.");
    }
  } else if (hyperliquidAddress) {
    console.warn("⚠️  HYPERLIQUID_ADDRESS env set but invalid; skipping.");
  }

  // ============================================
  // 3. Optional: fund contract with ETH for redemptions
  // ============================================
  const fundAmount = process.env.FUND_KASHYIELD_ETH || "0";
  if (fundAmount !== "0") {
    const wei = hre.ethers.parseEther(fundAmount);
    const tx = await deployer.sendTransaction({ to: kashYieldEthAddress, value: wei });
    await tx.wait();
    console.log("✅ Funded KashYieldETH with", fundAmount, "ETH");
  }

  // ============================================
  // 4. Summary and verification
  // ============================================
  console.log("\n====================================");
  console.log("📋 ARBITRUM SEPOLIA DEPLOYMENT");
  console.log("====================================");
  console.log("  KashYieldETH:", kashYieldEthAddress);
  console.log("  KashTokenEth:", kashTokenEthAddress);
  console.log("  Aave pool:   ", await kashYieldEth.aavePoolAddress());
  console.log("  USDC:        ", await kashYieldEth.usdcAddress());
  console.log("  Initial NAV: ", hre.ethers.formatEther(await kashYieldEth.currentNAV()), "USD");
  console.log("  Fee (bps):   ", await kashYieldEth.feeBps());
  console.log("  Paused:      ", await kashYieldEth.paused());
  console.log("====================================\n");
  console.log("Add to .env, frontend/.env.local, and bot/.env:");
  console.log(`  KASH_YIELD_ADDRESS=${kashYieldEthAddress}`);
  console.log(`  KASH_TOKEN_ADDRESS=${kashTokenEthAddress}`);

  // ============================================
  // 5. Save deployment info
  // ============================================
  const deploymentsDir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }

  const deploymentInfo = {
    network,
    chainId: (await hre.ethers.provider.getNetwork()).chainId.toString(),
    timestamp: new Date().toISOString(),
    deployer: deployer.address,
    contracts: {
      kashYieldEth: kashYieldEthAddress,
      kashTokenEth: kashTokenEthAddress,
    },
    builtInAddresses: {
      aavePool: await kashYieldEth.aavePoolAddress(),
      weth: await kashYieldEth.wethAddress(),
      usdc: await kashYieldEth.usdcAddress(),
    },
    ...(hyperliquidAddress && hre.ethers.isAddress(hyperliquidAddress)
      ? { hyperliquidAddress }
      : {}),
  };

  const filename = `deployment-${network}-${Date.now()}.json`;
  const filepath = path.join(deploymentsDir, filename);
  fs.writeFileSync(filepath, JSON.stringify(deploymentInfo, null, 2));
  console.log("💾 Saved:", filepath);

  console.log("\nVerify on Arbiscan (optional):");
  console.log("  npx hardhat verify --network arbitrumSepolia", kashYieldEthAddress);
  console.log("\n✅ Done.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
