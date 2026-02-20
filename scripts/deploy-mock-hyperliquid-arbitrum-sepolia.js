// scripts/deploy-mock-hyperliquid-arbitrum-sepolia.js
// Deploys MockHyperliquid to Arbitrum Sepolia using the same USDC, USDT, wBTC
// addresses as KashYield. Then set HYPERLIQUID_ADDRESS in .env and run setHyperliquid.js.
//
// Usage: npx hardhat run scripts/deploy-mock-hyperliquid-arbitrum-sepolia.js --network arbitrumSepolia

const hre = require("hardhat");

// Arbitrum Sepolia token addresses (same as KashYield / frontend)
const USDC = "0x15BB91b9e63EA29863678B1dcBcB01dE31bD8Ab5";
const USDT = "0x833EdA586220B1d0C25034E9bAb5ed4B4a5769a1";
const WBTC = "0x4D8b720b94D341F54df948696747B05998c5FbD5";

async function main() {
  const network = hre.network.name;
  if (network !== "arbitrumSepolia") {
    console.warn(`⚠️  Intended for Arbitrum Sepolia. You are on: ${network}`);
  }

  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying MockHyperliquid to", network);
  console.log("Deployer:", deployer.address);
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Balance:", hre.ethers.formatEther(balance), "ETH\n");

  const MockHyperliquid = await hre.ethers.getContractFactory("MockHyperliquid");
  const mock = await MockHyperliquid.deploy(USDC, USDT, WBTC);
  await mock.waitForDeployment();
  const address = await mock.getAddress();

  console.log("✅ MockHyperliquid deployed to:", address);
  console.log("\nNext steps:");
  console.log("  1. Add to .env: HYPERLIQUID_ADDRESS=" + address);
  console.log("  2. Run: npx hardhat run scripts/setHyperliquid.js --network arbitrumSepolia");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
