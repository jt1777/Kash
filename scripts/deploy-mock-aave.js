// scripts/deploy-mock-aave.js
// Deploys MockUSDC, MockWBTC, and MockAaveV3 (with ETH + wBTC support).
// Use for local testing or Arbitrum Sepolia with full mock stack.
//
// Usage:
//   Local:    npx hardhat run scripts/deploy-mock-aave.js
//   Sepolia:  npx hardhat run scripts/deploy-mock-aave.js --network arbitrumSepolia
//
// Optional env vars for Arbitrum Sepolia (use existing tokens instead of deploying mocks):
//   MOCK_AAVE_USDC_ADDRESS - existing USDC for borrow/repay (omit to deploy MockUSDC)
//   MOCK_AAVE_WBTC_ADDRESS - existing wBTC for supply/withdraw (omit to deploy MockWBTC)

const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network = hre.network.name;

  console.log("Deploying MockAaveV3 stack to", network);
  console.log("Deployer:", deployer.address);
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Balance:", hre.ethers.formatEther(balance), "ETH\n");

  let usdcAddress, wbtcAddress;

  // Deploy or use existing USDC
  if (process.env.MOCK_AAVE_USDC_ADDRESS) {
    usdcAddress = process.env.MOCK_AAVE_USDC_ADDRESS;
    console.log("Using existing USDC:", usdcAddress);
  } else {
    const MockUSDC = await hre.ethers.getContractFactory("MockUSDC");
    const usdc = await MockUSDC.deploy(1_000_000);
    await usdc.waitForDeployment();
    usdcAddress = await usdc.getAddress();
    console.log("✅ MockUSDC deployed to:", usdcAddress);
  }

  // Deploy or use existing wBTC
  if (process.env.MOCK_AAVE_WBTC_ADDRESS) {
    wbtcAddress = process.env.MOCK_AAVE_WBTC_ADDRESS;
    console.log("Using existing wBTC:", wbtcAddress);
  } else {
    const MockWBTC = await hre.ethers.getContractFactory("MockWBTC");
    const wbtc = await MockWBTC.deploy(100); // 100 mWBTC initial supply
    await wbtc.waitForDeployment();
    wbtcAddress = await wbtc.getAddress();
    console.log("✅ MockWBTC deployed to:", wbtcAddress);
  }

  // Deploy MockAaveV3
  const MockAaveV3 = await hre.ethers.getContractFactory("MockAaveV3");
  const mockAave = await MockAaveV3.deploy(usdcAddress);
  await mockAave.waitForDeployment();
  const mockAaveAddress = await mockAave.getAddress();
  console.log("✅ MockAaveV3 deployed to:", mockAaveAddress);

  // Configure wBTC support
  const tx = await mockAave.setWbtcAddress(wbtcAddress);
  await tx.wait();
  console.log("✅ Set wBTC address on MockAaveV3");

  // Fund MockAave with USDC for borrows (only if we deployed MockUSDC)
  if (!process.env.MOCK_AAVE_USDC_ADDRESS) {
    const usdc = await hre.ethers.getContractAt("MockUSDC", usdcAddress);
    await usdc.mint(mockAaveAddress, hre.ethers.parseUnits("50000", 6));
    console.log("✅ Funded MockAave with 50,000 USDC");
  }

  // Summary
  console.log("\n====================================");
  console.log("📋 DEPLOYMENT SUMMARY");
  console.log("====================================");
  console.log("  MockAaveV3:", mockAaveAddress);
  console.log("  USDC:     ", usdcAddress);
  console.log("  wBTC:     ", wbtcAddress);
  console.log("====================================\n");

  console.log("Next steps:");
  console.log("  1. For KashYieldBtc: set wbtcAddress and aavePoolAddress");
  console.log("  2. Add to .env: AAVE_POOL_ADDRESS=" + mockAaveAddress);
  if (!process.env.MOCK_AAVE_WBTC_ADDRESS) {
    console.log("  3. Mint MockWBTC to testers: MockWBTC.mint(address, amount)");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
