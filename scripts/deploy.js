const hre = require("hardhat");

async function main() {
  console.log("Starting KashYield deployment...\n");

  // Get deployer account
  const [deployer] = await ethers.getSigners();
  console.log("Deploying contracts with account:", deployer.address);
  console.log("Account balance:", (await ethers.provider.getBalance(deployer.address)).toString(), "\n");

  // ============================================
  // 1. Deploy Mock Contracts (for testing)
  // ============================================
  
  console.log("Deploying Mock Contracts...");
  
  // Deploy Mock Aave Pool
  const MockAaveV3 = await ethers.getContractFactory("MockAaveV3");
  const mockAave = await MockAaveV3.deploy();
  await mockAave.waitForDeployment();
  console.log("✅ MockAaveV3 deployed to:", await mockAave.getAddress());

  // Deploy Mock Tokens
  const MockUSDT = await ethers.getContractFactory("MockUSDT");
  const usdt = await MockUSDT.deploy();
  await usdt.waitForDeployment();
  console.log("✅ MockUSDT deployed to:", await usdt.getAddress());

  const usdc = await MockUSDT.deploy(); // Reuse MockUSDT for USDC
  await usdc.waitForDeployment();
  console.log("✅ MockUSDC deployed to:", await usdc.getAddress());

  // Deploy Mock ERC20 for wETH and wBTC
  const MockERC20 = await ethers.getContractFactory("MockUSDT"); // Generic ERC20
  const weth = await MockERC20.deploy();
  await weth.waitForDeployment();
  console.log("✅ wETH deployed to:", await weth.getAddress());

  const wbtc = await MockERC20.deploy();
  await wbtc.waitForDeployment();
  console.log("✅ wBTC deployed to:", await wbtc.getAddress());

  // Deploy Mock Hyperliquid (placeholder)
  const MockHyperliquid = await ethers.getContractFactory("MockAaveV3"); // Reuse as placeholder
  const mockHyperliquid = await MockHyperliquid.deploy();
  await mockHyperliquid.waitForDeployment();
  console.log("✅ MockHyperliquid deployed to:", await mockHyperliquid.getAddress());

  console.log("\n");

  // ============================================
  // 2. Deploy KashYield Main Contract
  // ============================================
  
  console.log("Deploying KashYield...");
  
  const KashYield = await ethers.getContractFactory("KashYield");
  const kashYield = await KashYield.deploy(
    await mockAave.getAddress(),      // aavePoolAddress
    await weth.getAddress(),           // wethAddress
    await wbtc.getAddress(),           // wbtcAddress
    await usdt.getAddress(),           // usdtAddress
    await usdc.getAddress(),           // usdcAddress
    await mockHyperliquid.getAddress() // hyperliquidAddress
  );
  await kashYield.waitForDeployment();
  
  const kashYieldAddress = await kashYield.getAddress();
  console.log("✅ KashYield deployed to:", kashYieldAddress);

  // Get KashToken address (created by KashYield constructor)
  const kashTokenAddress = await kashYield.kashToken();
  console.log("✅ KashToken deployed to:", kashTokenAddress);

  console.log("\n");

  // ============================================
  // 3. Print Deployment Summary
  // ============================================
  
  console.log("====================================");
  console.log("📋 DEPLOYMENT SUMMARY");
  console.log("====================================");
  console.log("\nCore Contracts:");
  console.log("  KashYield:", kashYieldAddress);
  console.log("  KashToken:", kashTokenAddress);
  console.log("\nMock Protocols:");
  console.log("  Aave Pool:", await mockAave.getAddress());
  console.log("  Hyperliquid:", await mockHyperliquid.getAddress());
  console.log("\nToken Addresses:");
  console.log("  wETH:", await weth.getAddress());
  console.log("  wBTC:", await wbtc.getAddress());
  console.log("  USDT:", await usdt.getAddress());
  console.log("  USDC:", await usdc.getAddress());
  console.log("\nInitial NAV:", ethers.formatEther(await kashYield.currentNAV()), "USD");
  console.log("====================================\n");

  // ============================================
  // 4. Save Deployment Addresses
  // ============================================
  
  const deploymentInfo = {
    network: hre.network.name,
    timestamp: new Date().toISOString(),
    deployer: deployer.address,
    contracts: {
      kashYield: kashYieldAddress,
      kashToken: kashTokenAddress,
      mockAave: await mockAave.getAddress(),
      mockHyperliquid: await mockHyperliquid.getAddress(),
      weth: await weth.getAddress(),
      wbtc: await wbtc.getAddress(),
      usdt: await usdt.getAddress(),
      usdc: await usdc.getAddress()
    }
  };

  const fs = require('fs');
  const path = require('path');
  const deploymentsDir = path.join(__dirname, '../deployments');
  
  // Create deployments directory if it doesn't exist
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }

  // Save deployment info
  const filename = `deployment-${hre.network.name}-${Date.now()}.json`;
  fs.writeFileSync(
    path.join(deploymentsDir, filename),
    JSON.stringify(deploymentInfo, null, 2)
  );
  console.log(`💾 Deployment info saved to: deployments/${filename}\n`);

  console.log("✅ Deployment completed successfully!");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
