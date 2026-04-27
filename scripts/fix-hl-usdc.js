/**
 * Fix "Invalid stablecoin" error: redeploys MockHyperliquid with the correct MockUSDC address,
 * then updates the existing HyperliquidAdapter to point at the new MockHL (no adapter redeploy needed).
 *
 * Required env vars:
 *   HL_ADAPTER_ADDRESS_ETH  - existing HyperliquidAdapter address
 *   MOCK_USDC_ADDRESS       - MockUSDC address (used by Aave, must match KashYieldETH.usdcAddress)
 *
 * Optional env vars:
 *   MOCK_USDT_ADDRESS       - MockUSDT (defaults to same as MockUSDC)
 *   MOCK_WBTC_ADDRESS       - MockWBTC (defaults to zero address)
 *   KASH_YIELD_ADDRESS      - KashYieldETH address (for diagnostic output only)
 *
 * Usage:
 *   HL_ADAPTER_ADDRESS_ETH=0x... MOCK_USDC_ADDRESS=0xc1BFb... \
 *   npx hardhat run scripts/fix-hl-usdc.js --network arbitrumSepolia
 */
const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();

  const adapterAddress = process.env.HL_ADAPTER_ADDRESS_ETH;
  const mockUsdc       = process.env.MOCK_USDC_ADDRESS;
  const mockUsdt       = process.env.MOCK_USDT_ADDRESS || mockUsdc;
  const mockWbtc       = process.env.MOCK_WBTC_ADDRESS || hre.ethers.ZeroAddress;

  if (!adapterAddress) throw new Error("Set HL_ADAPTER_ADDRESS_ETH");
  if (!mockUsdc)       throw new Error("Set MOCK_USDC_ADDRESS (your MockUSDC address)");

  console.log("\nDeployer:          ", deployer.address);
  console.log("HyperliquidAdapter:", adapterAddress);
  console.log("MockUSDC:          ", mockUsdc);
  console.log("MockUSDT:          ", mockUsdt);
  console.log("MockWBTC:          ", mockWbtc);

  // 1. Deploy fresh MockHyperliquid with correct USDC
  console.log("\n1. Deploying new MockHyperliquid with correct MockUSDC...");
  const MockHL = await hre.ethers.getContractFactory("MockHyperliquid");
  const newHL  = await MockHL.deploy(mockUsdc, mockUsdt, mockWbtc);
  await newHL.waitForDeployment();
  const newHLAddress = await newHL.getAddress();
  console.log("   ✅ New MockHyperliquid:", newHLAddress);

  // 2. Point the existing adapter at the new MockHL
  console.log("\n2. Updating HyperliquidAdapter.hyperliquidAddress...");
  const adapterAbi = ["function setHyperliquidAddress(address) external"];
  const adapter    = new hre.ethers.Contract(adapterAddress, adapterAbi, deployer);
  await (await adapter.setHyperliquidAddress(newHLAddress)).wait();
  console.log("   ✅ Adapter now points to:", newHLAddress);

  // 3. Fund new MockHL with MockUSDC so it can pay out on spot trades
  console.log("\n3. Funding new MockHL with MockUSDC for spot trading...");
  const usdcAbi = ["function mint(address to, uint256 amount) external", "function balanceOf(address) view returns (uint256)"];
  const usdc = new hre.ethers.Contract(mockUsdc, usdcAbi, deployer);
  const fundAmount = hre.ethers.parseUnits("50000", 6);
  try {
    await (await usdc.mint(newHLAddress, fundAmount)).wait();
    console.log("   ✅ Funded with 50,000 MockUSDC");
  } catch (e) {
    console.warn("   ⚠️  Could not mint USDC to MockHL:", e.shortMessage || e.message);
    console.warn("       Fund manually if spot trades are needed.");
  }

  // Summary
  console.log("\n========================================");
  console.log("Fix complete!");
  console.log("========================================");
  console.log("New MockHyperliquid:", newHLAddress);
  console.log("Adapter updated:    ", adapterAddress);
  console.log("\nAdd to your .env files:");
  console.log("  HYPERLIQUID_ADDRESS=" + newHLAddress);
  console.log("\nThen set ETH price on new MockHL (and matching mock oracle/Aave if needed), e.g. MockHyperliquid.setEthPrice(...).");
  console.log("\nThen re-run the bot.");
}

main().catch((e) => { console.error(e); process.exit(1); });
