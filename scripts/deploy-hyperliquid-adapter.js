// scripts/deploy-hyperliquid-adapter.js
// Deploys a HyperliquidAdapter contract that wraps MockHyperliquid (testnet)
// or the real Hyperliquid bridge (mainnet) and exposes the IPerpExchange interface.
//
// This adapter is the address you pass to setHyperliquid.js (not MockHL directly).
// The main KashYield contract talks to this adapter; the adapter talks to the underlying HL.
//
// Usage (BTC product):
//   MOCK_HL_ADDRESS=0x...  USDC_ADDRESS=0x...  WBTC_ADDRESS=0x...  \
//   npx hardhat run scripts/deploy-hyperliquid-adapter.js --network arbitrumSepolia
//
// Usage (ETH product):
//   MOCK_HL_ADDRESS=0x...  USDC_ADDRESS=0x...  IS_ETH_ASSET=true   \
//   npx hardhat run scripts/deploy-hyperliquid-adapter.js --network arbitrumSepolia
//
// Required env vars:
//   MOCK_HL_ADDRESS    — deployed MockHyperliquid (testnet) or real HL bridge (mainnet)
//   USDC_ADDRESS       — USDC / MockUSDC address
//   WBTC_ADDRESS       — wBTC / MockWBTC address (BTC product only; ignored when IS_ETH_ASSET=true)
//
// Optional:
//   IS_ETH_ASSET=true  — set for the ETH product adapter (assetAddress = 0x0, isEthAsset = true)
//   HL_ADAPTER_LABEL   — label printed in output (e.g. "BTC" or "ETH", default: auto-detected)

require("dotenv").config();
const hre = require("hardhat");
const fs  = require("fs");
const path = require("path");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network = hre.network.name;

  console.log("Deploying HyperliquidAdapter to", network);
  console.log("Deployer:", deployer.address);

  const hlAddress   = process.env.MOCK_HL_ADDRESS || process.env.HYPERLIQUID_MOCK_ADDRESS;
  const usdcAddress = process.env.USDC_ADDRESS   || process.env.MOCK_USDC_ADDRESS;
  const wbtcAddress = process.env.WBTC_ADDRESS   || process.env.MOCK_WBTC;
  const isEth       = (process.env.IS_ETH_ASSET || "").toLowerCase() === "true";
  const label       = process.env.HL_ADAPTER_LABEL || (isEth ? "ETH" : "BTC");

  if (!hlAddress || !hre.ethers.isAddress(hlAddress)) {
    throw new Error(
      "Set MOCK_HL_ADDRESS in .env — the address of your deployed MockHyperliquid (testnet) " +
      "or the real Hyperliquid bridge (mainnet)."
    );
  }
  if (!usdcAddress || !hre.ethers.isAddress(usdcAddress)) {
    throw new Error("Set USDC_ADDRESS (or MOCK_USDC_ADDRESS) in .env.");
  }

  // For the ETH product the on-chain asset is native ETH, so assetAddress = 0x0.
  // For the BTC product assetAddress = wBTC ERC-20 contract.
  const assetAddress = isEth ? hre.ethers.ZeroAddress : wbtcAddress;
  if (!isEth && (!wbtcAddress || !hre.ethers.isAddress(wbtcAddress))) {
    throw new Error(
      "Set WBTC_ADDRESS (or MOCK_WBTC) in .env for the BTC adapter. " +
      "Or set IS_ETH_ASSET=true for the ETH product."
    );
  }

  console.log("\nParameters:");
  console.log("  Product:      ", label);
  console.log("  HL address:   ", hlAddress);
  console.log("  USDC:         ", usdcAddress);
  console.log("  Asset:        ", isEth ? "(native ETH)" : assetAddress);
  console.log("  isEthAsset:   ", isEth);
  console.log("");

  const HyperliquidAdapter = await hre.ethers.getContractFactory("HyperliquidAdapter");
  const adapter = await HyperliquidAdapter.deploy(hlAddress, usdcAddress, assetAddress, isEth);
  await adapter.waitForDeployment();
  const adapterAddress = await adapter.getAddress();

  console.log(`✅ HyperliquidAdapter (${label}):`, adapterAddress);

  console.log("\n====================================");
  console.log(`📋 HYPERLIQUID ADAPTER (${label})`);
  console.log("====================================");
  console.log("  HyperliquidAdapter:", adapterAddress);
  console.log("  Wraps (HL/Mock):   ", hlAddress);
  console.log("  USDC:              ", usdcAddress);
  console.log("  Asset:             ", isEth ? "native ETH" : assetAddress);
  console.log("====================================");
  console.log("\nNext steps:");
  console.log("  1. Add to .env:");
  console.log(`       HL_ADAPTER_ADDRESS=${adapterAddress}`);
  console.log("  2. Register + propose activation on KashYield:");
  console.log("       HYPERLIQUID_ADDRESS=$HL_ADAPTER_ADDRESS npx hardhat run scripts/setHyperliquid.js --network", network);
  console.log("  3. After 48 hours, confirm the active exchange:");
  console.log("       npx hardhat run scripts/confirmActivePerpExchange.js --network", network);
  console.log("\n  (For Hardhat local/testnet testing, fast-forward time first — see DEPLOYMENT.md)\n");

  // Save to deployments/
  const deploymentsDir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(deploymentsDir)) fs.mkdirSync(deploymentsDir, { recursive: true });
  const info = {
    network,
    timestamp: new Date().toISOString(),
    deployer: deployer.address,
    product: label,
    contracts: {
      hyperliquidAdapter: adapterAddress,
      hyperliquidMock: hlAddress,
      usdc: usdcAddress,
      asset: assetAddress,
      isEthAsset: isEth,
    },
  };
  const filepath = path.join(deploymentsDir, `hl-adapter-${label.toLowerCase()}-${network}-${Date.now()}.json`);
  fs.writeFileSync(filepath, JSON.stringify(info, null, 2));
  console.log("💾 Saved:", filepath);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
