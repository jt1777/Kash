// scripts/deploy-arbitrum-sepolia.js
// Deploys KashYield to Arbitrum Sepolia. Uses built-in Sepolia addresses (Aave, tokens, oracles).
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

  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying to", network);
  console.log("Deployer:", deployer.address);
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Balance:", hre.ethers.formatEther(balance), "ETH\n");

  if (balance === 0n) {
    throw new Error("Deployer balance is 0. Get testnet ETH from Arbitrum Sepolia faucet.");
  }

  // ============================================
  // 1. Deploy KashYield (no constructor args)
  // ============================================
  // Contract already has Arbitrum Sepolia addresses for:
  //   aavePoolAddress, weth, wbtc, usdt, usdc, token oracles
  console.log("Deploying KashYield...");
  const KashYield = await hre.ethers.getContractFactory("KashYield");
  const kashYield = await KashYield.deploy();
  await kashYield.waitForDeployment();

  const kashYieldAddress = await kashYield.getAddress();
  const kashTokenAddress = await kashYield.kashToken();
  console.log("✅ KashYield:", kashYieldAddress);
  console.log("✅ KashToken:", kashTokenAddress);

  // ============================================
  // 2. Optional: set Hyperliquid adapter
  // ============================================
  const hyperliquidAddress = process.env.HYPERLIQUID_ADDRESS || "";
  if (hyperliquidAddress && hre.ethers.isAddress(hyperliquidAddress)) {
    const tx = await kashYield.setHyperliquid(hyperliquidAddress);
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
    const tx = await deployer.sendTransaction({ to: kashYieldAddress, value: wei });
    await tx.wait();
    console.log("✅ Funded KashYield with", fundAmount, "ETH");
  }

  // ============================================
  // 4. Summary and verification
  // ============================================
  console.log("\n====================================");
  console.log("📋 ARBITRUM SEPOLIA DEPLOYMENT");
  console.log("====================================");
  console.log("  KashYield:", kashYieldAddress);
  console.log("  KashToken:", kashTokenAddress);
  console.log("  Aave pool (built-in):", await kashYield.aavePoolAddress());
  console.log("  Initial NAV:", hre.ethers.formatEther(await kashYield.currentNAV()), "USD");
  console.log("  Fee (bps):", await kashYield.feeBps());
  console.log("  Paused:", await kashYield.paused());
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
      kashYield: kashYieldAddress,
      kashToken: kashTokenAddress,
    },
    builtInAddresses: {
      aavePool: await kashYield.aavePoolAddress(),
      weth: await kashYield.wethAddress(),
      wbtc: await kashYield.wbtcAddress(),
      usdt: await kashYield.usdtAddress(),
      usdc: await kashYield.usdcAddress(),
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
  console.log("  npx hardhat verify --network arbitrumSepolia", kashYieldAddress);
  console.log("\n✅ Done.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
