const hre = require("hardhat");

async function main() {
  console.log("Starting KashYield deployment...\n");

  // Get deployer account
  const [deployer] = await ethers.getSigners();
  console.log("Deploying contracts with account:", deployer.address);
  console.log("Account balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH\n");

  // ============================================
  // 1. Deploy Mock Tokens First
  // ============================================
  
  console.log("Deploying Mock Tokens...");
  
  const MockUSDT = await ethers.getContractFactory("MockUSDT");
  
  const usdt = await MockUSDT.deploy(1_000_000); // 1M initial supply
  await usdt.waitForDeployment();
  console.log("✅ MockUSDT deployed to:", await usdt.getAddress());

  const usdc = await MockUSDT.deploy(1_000_000);
  await usdc.waitForDeployment();
  console.log("✅ MockUSDC deployed to:", await usdc.getAddress());

  const weth = await MockUSDT.deploy(10_000);
  await weth.waitForDeployment();
  console.log("✅ Mock wETH deployed to:", await weth.getAddress());

  const wbtc = await MockUSDT.deploy(100);
  await wbtc.waitForDeployment();
  console.log("✅ Mock wBTC deployed to:", await wbtc.getAddress());

  console.log("\n");

  // ============================================
  // 2. Deploy Chainlink Price Feed Mocks
  // ============================================
  
  console.log("Deploying Mock Chainlink Price Feeds...");
  
  const MockPriceFeed = await ethers.getContractFactory("MockChainlinkPriceFeed");
  
  const ethFeed = await MockPriceFeed.deploy(300000000000n); // $3000 (8 decimals)
  await ethFeed.waitForDeployment();
  console.log("✅ ETH/USD Feed deployed to:", await ethFeed.getAddress());
  
  const btcFeed = await MockPriceFeed.deploy(6000000000000n); // $60,000 (8 decimals)
  await btcFeed.waitForDeployment();
  console.log("✅ BTC/USD Feed deployed to:", await btcFeed.getAddress());
  
  const usdcFeed = await MockPriceFeed.deploy(100000000n); // $1.00 (8 decimals)
  await usdcFeed.waitForDeployment();
  console.log("✅ USDC/USD Feed deployed to:", await usdcFeed.getAddress());
  
  const usdtFeed = await MockPriceFeed.deploy(100000000n); // $1.00 (8 decimals)
  await usdtFeed.waitForDeployment();
  console.log("✅ USDT/USD Feed deployed to:", await usdtFeed.getAddress());

  console.log("\n");

  // ============================================
  // 3. Deploy Mock Aave (needs USDT address)
  // ============================================
  
  console.log("Deploying Mock Aave...");
  
  const MockAaveV3 = await ethers.getContractFactory("MockAaveV3");
  const mockAave = await MockAaveV3.deploy(await usdt.getAddress());
  await mockAave.waitForDeployment();
  console.log("✅ MockAaveV3 deployed to:", await mockAave.getAddress());
  
  // Fund Aave with USDT for borrows
  await usdt.mint(await mockAave.getAddress(), ethers.parseUnits("50000", 6));
  console.log("✅ Funded Aave with 50,000 USDT");

  console.log("\n");

  // ============================================
  // 4. Deploy Mock Hyperliquid
  // ============================================
  
  console.log("Deploying Mock Hyperliquid...");
  
  const MockHyperliquid = await ethers.getContractFactory("MockHyperliquid");
  const mockHyperliquid = await MockHyperliquid.deploy(
    await usdc.getAddress(),
    await usdt.getAddress(),
    await wbtc.getAddress()
  );
  await mockHyperliquid.waitForDeployment();
  console.log("✅ MockHyperliquid deployed to:", await mockHyperliquid.getAddress());

  console.log("\n");

  // ============================================
  // 5. Deploy KashYield Main Contract
  // ============================================
  
  console.log("Deploying KashYieldETH...");
  
  const KashYieldETH = await ethers.getContractFactory("KashYieldETH");
  const kashYieldEth = await KashYieldETH.deploy();
  await kashYieldEth.waitForDeployment();
  
  const kashYieldEthAddress = await kashYieldEth.getAddress();
  console.log("✅ KashYieldETH deployed to:", kashYieldEthAddress);

  const kashTokenEthAddress = await kashYieldEth.kashTokenEth();
  console.log("✅ KashTokenEth deployed to:", kashTokenEthAddress);

  console.log("\n");

  // ============================================
  // 6. Configure KashYield
  // ============================================
  
  console.log("Configuring KashYieldETH...");
  
  await kashYieldEth.setAavePool(await mockAave.getAddress());
  console.log("✅ Set Aave pool address");
  
  await kashYieldEth.setTokenAddresses(
    await weth.getAddress(),
    await wbtc.getAddress(),
    await usdt.getAddress(),
    await usdc.getAddress()
  );
  console.log("✅ Set token addresses");
  
  await kashYieldEth.setOracle(ethers.ZeroAddress, await ethFeed.getAddress());
  await kashYieldEth.setOracle(await weth.getAddress(), await ethFeed.getAddress());
  await kashYieldEth.setOracle(await wbtc.getAddress(), await btcFeed.getAddress());
  await kashYieldEth.setOracle(await usdt.getAddress(), await usdtFeed.getAddress());
  await kashYieldEth.setOracle(await usdc.getAddress(), await usdcFeed.getAddress());
  console.log("✅ Set oracle addresses");
  
  await kashYieldEth.setTokenDecimals(await weth.getAddress(), 6);
  await kashYieldEth.setTokenDecimals(await wbtc.getAddress(), 6);
  await kashYieldEth.setTokenDecimals(await usdt.getAddress(), 6);
  await kashYieldEth.setTokenDecimals(await usdc.getAddress(), 6);
  console.log("✅ Set token decimals");
  
  const fundTx = await deployer.sendTransaction({
    to: kashYieldEthAddress,
    value: ethers.parseEther("0.01")
  });
  await fundTx.wait();
  console.log("✅ Funded KashYieldETH with 0.01 ETH");

  console.log("\n");

  // ============================================
  // 7. Print Deployment Summary
  // ============================================
  
  console.log("====================================");
  console.log("📋 DEPLOYMENT SUMMARY");
  console.log("====================================");
  console.log("\nCore Contracts:");
  console.log("  KashYieldETH:", kashYieldEthAddress);
  console.log("  KashTokenEth:", kashTokenEthAddress);
  console.log("\nMock Protocols:");
  console.log("  Aave Pool:", await mockAave.getAddress());
  console.log("  Hyperliquid:", await mockHyperliquid.getAddress());
  console.log("\nToken Addresses:");
  console.log("  wETH:", await weth.getAddress());
  console.log("  wBTC:", await wbtc.getAddress());
  console.log("  USDT:", await usdt.getAddress());
  console.log("  USDC:", await usdc.getAddress());
  console.log("\nChainlink Price Feeds:");
  console.log("  ETH/USD:", await ethFeed.getAddress());
  console.log("  BTC/USD:", await btcFeed.getAddress());
  console.log("  USDC/USD:", await usdcFeed.getAddress());
  console.log("  USDT/USD:", await usdtFeed.getAddress());
  console.log("\nConfiguration:");
  console.log("  Initial NAV:", ethers.formatEther(await kashYield.currentNAV()), "USD");
  console.log("  Fee (bps):", await kashYield.feeBps());
  console.log("  Paused:", await kashYield.paused());
  console.log("====================================\n");

  // ============================================
  // 8. Save Deployment Addresses
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
      usdc: await usdc.getAddress(),
      ethFeed: await ethFeed.getAddress(),
      btcFeed: await btcFeed.getAddress(),
      usdcFeed: await usdcFeed.getAddress(),
      usdtFeed: await usdtFeed.getAddress()
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
