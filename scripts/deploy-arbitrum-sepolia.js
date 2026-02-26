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
  console.log("Deploying KashYieldETH (botAddress:", botAddress, ")...");
  const KashYieldETH = await hre.ethers.getContractFactory("KashYieldETH");
  const kashYieldEth = await KashYieldETH.deploy(botAddress);
  await kashYieldEth.waitForDeployment();

  const kashYieldEthAddress = await kashYieldEth.getAddress();
  const kashTokenEthAddress = await kashYieldEth.kashTokenEth();
  console.log("✅ KashYieldETH:", kashYieldEthAddress);
  console.log("✅ KashTokenEth:", kashTokenEthAddress);

  // ============================================
  // 2. Optional: set Hyperliquid adapter
  // ============================================
  const hyperliquidAddress = process.env.HYPERLIQUID_ADDRESS || "";
  if (hyperliquidAddress && hre.ethers.isAddress(hyperliquidAddress)) {
    const tx = await kashYieldEth.setHyperliquid(hyperliquidAddress);
    await tx.wait();
    console.log("✅ Hyperliquid address set:", hyperliquidAddress);
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
  console.log("  Aave pool (built-in):", await kashYieldEth.aavePoolAddress());
  console.log("  Initial NAV:", hre.ethers.formatEther(await kashYieldEth.currentNAV()), "USD");
  console.log("  Fee (bps):", await kashYieldEth.feeBps());
  console.log("  Paused:", await kashYieldEth.paused());
  console.log("====================================\n");

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
