// scripts/deploy-mock-aave.js
// Deploys MockUSDC, MockWBTC, and MockAaveV3 (with ETH + wBTC support).
// Use for local testing or Arbitrum Sepolia with full mock stack.
//
// Usage:
//   Local:    npx hardhat run scripts/deploy-mock-aave.js
//   Sepolia:  npx hardhat run scripts/deploy-mock-aave.js --network arbitrumSepolia
//
// Optional env vars for Arbitrum Sepolia (use existing tokens instead of deploying mocks):
//   USDC_ADDRESS or MOCK_AAVE_USDC_ADDRESS - existing USDC for borrow/repay (omit to deploy MockUSDC)
//   WBTC_ADDRESS or MOCK_AAVE_WBTC_ADDRESS - existing wBTC for supply/withdraw (omit to deploy MockWBTC)
//   WETH_ADDRESS or MOCK_WETH_ADDRESS      - WETH address for ETH product support (setWethAddress)

const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network = hre.network.name;

  console.log("Deploying MockAaveV3 stack to", network);
  console.log("Deployer:", deployer.address);
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Balance:", hre.ethers.formatEther(balance), "ETH\n");

  let usdcAddress, wbtcAddress;

  // Deploy or use existing USDC (accepts MOCK_AAVE_USDC_ADDRESS or USDC_ADDRESS)
  const existingUsdc = process.env.MOCK_AAVE_USDC_ADDRESS || process.env.USDC_ADDRESS || "";
  if (existingUsdc) {
    usdcAddress = existingUsdc;
    console.log("Using existing USDC:", usdcAddress);
  } else {
    const MockUSDC = await hre.ethers.getContractFactory("MockUSDC");
    const usdc = await MockUSDC.deploy(1_000_000);
    await usdc.waitForDeployment();
    usdcAddress = await usdc.getAddress();
    console.log("✅ MockUSDC deployed to:", usdcAddress);
  }

  // Deploy or use existing wBTC (accepts MOCK_AAVE_WBTC_ADDRESS or WBTC_ADDRESS)
  const existingWbtc = process.env.MOCK_AAVE_WBTC_ADDRESS || process.env.WBTC_ADDRESS || "";
  if (existingWbtc) {
    wbtcAddress = existingWbtc;
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

  // Configure WETH support (required for ETH product)
  const wethAddress = process.env.WETH_ADDRESS || process.env.MOCK_WETH_ADDRESS || "";
  if (wethAddress) {
    const tx2 = await mockAave.setWethAddress(wethAddress);
    await tx2.wait();
    console.log("✅ Set WETH address on MockAaveV3:", wethAddress);
  } else {
    console.log("⚠️  WETH_ADDRESS not set — skipping setWethAddress (required for ETH product)");
  }

  // Fund MockAave with USDC for borrows (always — MockUSDC mint is owner-callable)
  const fundUsdc = process.env.FUND_MOCK_AAVE_USDC
    ? hre.ethers.parseUnits(process.env.FUND_MOCK_AAVE_USDC, 6)
    : hre.ethers.parseUnits("50000", 6);
  try {
    const usdc = await hre.ethers.getContractAt("MockUSDC", usdcAddress);
    await (await usdc.mint(mockAaveAddress, fundUsdc)).wait();
    console.log(`✅ Funded MockAave with ${hre.ethers.formatUnits(fundUsdc, 6)} USDC`);
  } catch (e) {
    console.warn("⚠️  Could not mint USDC to MockAave (not owner, or not MockUSDC):", e.message?.split("\n")[0]);
    console.warn("   Fund manually: usdc.mint(<MockAaveV3>, amount)");
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
