// scripts/deploy-mock-hyperliquid-arbitrum-sepolia.js
// Deploys MockHyperliquid to Arbitrum Sepolia.
//
// Accepts USDC_ADDRESS or MOCK_USDC_ADDRESS (same for WBTC).
// If your .env already has USDC_ADDRESS and WBTC_ADDRESS, just run the script — no extra flags needed.
//
// ⚠️  Always set USDC_ADDRESS (MockUSDC) so MockHyperliquid uses the same token as KashYield.
//     Without it the script falls back to the real Arbitrum Sepolia USDC, which causes
//     "Invalid stablecoin" errors on every Hyperliquid deposit.
//
// Usage:
//   npx hardhat run scripts/deploy-mock-hyperliquid-arbitrum-sepolia.js --network arbitrumSepolia

require("dotenv").config();
const hre = require("hardhat");

// Arbitrum Sepolia real token addresses — only used as last-resort fallback.
// Always prefer setting USDC_ADDRESS / WBTC_ADDRESS (or MOCK_USDC_ADDRESS / MOCK_WBTC_ADDRESS)
// in your .env so MockHyperliquid is deployed with the same USDC as KashYieldETH/BTC.
const USDC_REAL = "0x15BB91b9e63EA29863678B1dcBcB01dE31bD8Ab5";
const WBTC_REAL = "0x4D8b720b94D341F54df948696747B05998c5FbD5";

async function main() {
  const network = hre.network.name;
  if (network !== "arbitrumSepolia") {
    console.warn(`⚠️  Intended for Arbitrum Sepolia. You are on: ${network}`);
  }

  // Accept either MOCK_USDC_ADDRESS or USDC_ADDRESS (same for WBTC).
  // ⚠️  If neither is set, falls back to the real Arbitrum Sepolia addresses, which will
  //     cause "Invalid stablecoin" errors if your KashYield contract uses MockUSDC.
  const usdc = process.env.MOCK_USDC_ADDRESS || process.env.USDC_ADDRESS || "";
  const wbtc = process.env.MOCK_WBTC_ADDRESS || process.env.WBTC_ADDRESS || "";

  let finalUsdc, finalWbtc;
  if (usdc && wbtc) {
    finalUsdc = usdc;
    finalWbtc = wbtc;
    console.log("Using tokens from .env:");
    console.log("  USDC:", finalUsdc);
    console.log("  WBTC:", finalWbtc, "\n");
  } else {
    finalUsdc = USDC_REAL;
    finalWbtc = WBTC_REAL;
    console.warn("⚠️  USDC_ADDRESS / WBTC_ADDRESS not set — falling back to real Arbitrum Sepolia addresses.");
    console.warn("    This will cause 'Invalid stablecoin' errors if KashYieldETH/BTC uses MockUSDC.");
    console.warn("    Set USDC_ADDRESS=<MockUSDC> WBTC_ADDRESS=<MockWBTC> and re-run.\n");
  }

  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying MockHyperliquid to", network);
  console.log("Deployer:", deployer.address);
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Balance:", hre.ethers.formatEther(balance), "ETH\n");

  const MockHyperliquid = await hre.ethers.getContractFactory("MockHyperliquid");
  // USDC used for both stablecoin slots; MockHyperliquid accepts USDC or USDT, we only use USDC.
  const mock = await MockHyperliquid.deploy(finalUsdc, finalUsdc, finalWbtc);
  await mock.waitForDeployment();
  const address = await mock.getAddress();

  console.log("✅ MockHyperliquid deployed to:", address);
  console.log("\nNext steps:");
  console.log("  1. Add to .env: HYPERLIQUID_ADDRESS=" + address);
  if (usdc) {
    console.log("  2. Run: KASH_YIELD_BTC_ADDRESS=<KashYieldBtc> HYPERLIQUID_ADDRESS=" + address + " npx hardhat run scripts/setHyperliquid.js --network arbitrumSepolia");
  } else {
    console.log("  2. Run: npx hardhat run scripts/setHyperliquid.js --network arbitrumSepolia");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
