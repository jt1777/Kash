// scripts/deploy-kashyieldbtc.js
// Deploys KashYieldBtc with full MockAave stack: MockUSDC, MockWBTC, MockAaveV3, MockChainlinkPriceFeed.
// Does NOT deploy MockHyperliquid — deploy that separately and set via setHyperliquid.js.
// Use for local testing (hardhat) or Arbitrum Sepolia.
//
// Usage:
//   Local:    npx hardhat run scripts/deploy-kashyieldbtc.js
//   Sepolia: npx hardhat run scripts/deploy-kashyieldbtc.js --network arbitrumSepolia
//
// Env: BOT_ADDRESS (optional) — bot/keeper address for performUpkeep; defaults to deployer.
//
// Output: Prints addresses. After full setup, add to frontend/.env.local and bot/.env (see DEPLOYMENT.md).

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network = hre.network.name;

  console.log("Deploying KashYieldBtc + MockAave stack to", network);
  console.log("Deployer:", deployer.address);
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Balance:", hre.ethers.formatEther(balance), "ETH\n");

  const botAddress = process.env.BOT_ADDRESS || deployer.address;

  // 1. MockUSDC (for Hyperliquid + MockAave borrow/repay)
  const MockUSDC = await hre.ethers.getContractFactory("MockUSDC");
  const usdc = await MockUSDC.deploy(1_000_000);
  await usdc.waitForDeployment();
  const usdcAddress = await usdc.getAddress();
  console.log("✅ MockUSDC:", usdcAddress);

  // 2. MockWBTC
  const MockWBTC = await hre.ethers.getContractFactory("MockWBTC");
  const wbtc = await MockWBTC.deploy(100);
  await wbtc.waitForDeployment();
  const wbtcAddress = await wbtc.getAddress();
  console.log("✅ MockWBTC:", wbtcAddress);

  // 3. MockChainlinkPriceFeed (BTC/USD $60k)
  const MockPriceFeed = await hre.ethers.getContractFactory("MockChainlinkPriceFeed");
  const btcFeed = await MockPriceFeed.deploy(6000000000000n); // 8 decimals
  await btcFeed.waitForDeployment();
  const btcFeedAddress = await btcFeed.getAddress();
  console.log("✅ Mock BTC/USD Feed:", btcFeedAddress);

  // 4. MockAaveV3
  const MockAaveV3 = await hre.ethers.getContractFactory("MockAaveV3");
  const mockAave = await MockAaveV3.deploy(usdcAddress);
  await mockAave.waitForDeployment();
  const mockAaveAddress = await mockAave.getAddress();
  await mockAave.setWbtcAddress(wbtcAddress);
  console.log("✅ MockAaveV3:", mockAaveAddress);

  await usdc.mint(mockAaveAddress, hre.ethers.parseUnits("50000", 6));
  console.log("   Funded MockAave with 50,000 USDC");

  // 5. KashYieldBtc
  const KashYieldBtc = await hre.ethers.getContractFactory("KashYieldBtc");
  const kashYieldBtc = await KashYieldBtc.deploy(botAddress);
  await kashYieldBtc.waitForDeployment();
  const kashYieldBtcAddress = await kashYieldBtc.getAddress();
  const kashTokenBtcAddress = await kashYieldBtc.kashTokenBtc();
  console.log("✅ KashYieldBtc:", kashYieldBtcAddress);
  console.log("✅ KashTokenBtc:", kashTokenBtcAddress);

  // 6. Configure KashYieldBtc
  await kashYieldBtc.setWbtcAddress(wbtcAddress);
  await kashYieldBtc.setAavePool(mockAaveAddress);
  await kashYieldBtc.setBtcOracle(btcFeedAddress);
  await kashYieldBtc.setUsdcAddress(usdcAddress);
  console.log("✅ Configured KashYieldBtc (wbtc, aave, oracle, usdc)");

  // 7. Mint MockWBTC to deployer for testing
  await wbtc.mint(deployer.address, hre.ethers.parseUnits("10", 8));
  console.log("✅ Minted 10 mWBTC to deployer");

  // Summary
  console.log("\n====================================");
  console.log("📋 KASHYIELDBTC + MOCK AAVE STACK");
  console.log("====================================");
  console.log("  KashYieldBtc:  ", kashYieldBtcAddress);
  console.log("  KashTokenBtc:  ", kashTokenBtcAddress);
  console.log("  MockAaveV3:    ", mockAaveAddress);
  console.log("  MockWBTC:      ", wbtcAddress);
  console.log("  MockUSDC:      ", usdcAddress);
  console.log("  BTC/USD Feed:  ", btcFeedAddress);
  console.log("====================================\n");

  console.log("Add to frontend/.env.local:");
  console.log(`  NEXT_PUBLIC_KASH_YIELD_BTC=${kashYieldBtcAddress}`);
  console.log(`  NEXT_PUBLIC_KASH_TOKEN_BTC=${kashTokenBtcAddress}`);
  console.log(`  NEXT_PUBLIC_MOCK_WBTC=${wbtcAddress}`);
  console.log("");

  // Save deployment
  const deploymentsDir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(deploymentsDir)) fs.mkdirSync(deploymentsDir, { recursive: true });
  const info = {
    network,
    timestamp: new Date().toISOString(),
    deployer: deployer.address,
    contracts: {
      kashYieldBtc: kashYieldBtcAddress,
      kashTokenBtc: kashTokenBtcAddress,
      mockAave: mockAaveAddress,
      mockWbtc: wbtcAddress,
      mockUsdc: usdcAddress,
      btcFeed: btcFeedAddress,
    },
  };
  const filepath = path.join(deploymentsDir, `kashyieldbtc-${network}-${Date.now()}.json`);
  fs.writeFileSync(filepath, JSON.stringify(info, null, 2));
  console.log("💾 Saved:", filepath);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
