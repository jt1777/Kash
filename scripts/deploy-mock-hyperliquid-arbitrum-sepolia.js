// scripts/deploy-mock-hyperliquid-arbitrum-sepolia.js
// Deploys MockHyperliquid to Arbitrum Sepolia.
//
// KashYieldETH (real tokens): no env vars – uses built-in Arbitrum Sepolia USDC, USDT, wBTC
// KashYieldBtc (mock stack): set MOCK_USDC_ADDRESS and MOCK_WBTC_ADDRESS from deploy-kashyieldbtc.js output
//
// Usage:
//   ETH:  npx hardhat run scripts/deploy-mock-hyperliquid-arbitrum-sepolia.js --network arbitrumSepolia
//   BTC:  MOCK_USDC_ADDRESS=0x... MOCK_WBTC_ADDRESS=0x... npx hardhat run scripts/deploy-mock-hyperliquid-arbitrum-sepolia.js --network arbitrumSepolia

require("dotenv").config();
const hre = require("hardhat");

// Arbitrum Sepolia real token addresses (for KashYieldETH)
const USDC_REAL = "0x15BB91b9e63EA29863678B1dcBcB01dE31bD8Ab5";
const USDT_REAL = "0x833EdA586220B1d0C25034E9bAb5ed4B4a5769a1";
const WBTC_REAL = "0x4D8b720b94D341F54df948696747B05998c5FbD5";

async function main() {
  const network = hre.network.name;
  if (network !== "arbitrumSepolia") {
    console.warn(`⚠️  Intended for Arbitrum Sepolia. You are on: ${network}`);
  }

  let usdc, usdt, wbtc;
  if (process.env.MOCK_USDC_ADDRESS && process.env.MOCK_WBTC_ADDRESS) {
    usdc = process.env.MOCK_USDC_ADDRESS;
    usdt = process.env.MOCK_USDT_ADDRESS || usdc; // use USDC for both if no USDT
    wbtc = process.env.MOCK_WBTC_ADDRESS;
    console.log("Using mock tokens (KashYieldBtc stack):");
    console.log("  USDC:", usdc);
    console.log("  USDT:", usdt);
    console.log("  WBTC:", wbtc, "\n");
  } else {
    usdc = USDC_REAL;
    usdt = USDT_REAL;
    wbtc = WBTC_REAL;
    console.log("Using real Arbitrum Sepolia tokens (KashYieldETH)\n");
  }

  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying MockHyperliquid to", network);
  console.log("Deployer:", deployer.address);
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Balance:", hre.ethers.formatEther(balance), "ETH\n");

  const MockHyperliquid = await hre.ethers.getContractFactory("MockHyperliquid");
  const mock = await MockHyperliquid.deploy(usdc, usdt, wbtc);
  await mock.waitForDeployment();
  const address = await mock.getAddress();

  console.log("✅ MockHyperliquid deployed to:", address);
  console.log("\nNext steps:");
  console.log("  1. Add to .env: HYPERLIQUID_ADDRESS=" + address);
  if (process.env.MOCK_USDC_ADDRESS) {
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
