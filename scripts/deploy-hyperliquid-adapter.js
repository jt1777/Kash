// scripts/deploy-hyperliquid-adapter.js
// Deploys a HyperliquidAdapter contract that wraps the real Hyperliquid bridge
// and exposes the IPerpExchange interface.
//
// This adapter is the address you pass to setHyperliquid.js.
// The main KashYield contract talks to this adapter; the adapter talks to the underlying HL.
//
// Usage (BTC product):
//   HYPERLIQUID_ADDRESS=0x...  USDC_ADDRESS=0x...  WBTC_ADDRESS=0x...  KASH_YIELD_ADDRESS=0x...  \
//   npx hardhat run scripts/deploy-hyperliquid-adapter.js --network arbitrumOne
//
// Usage (ETH product):
//   HYPERLIQUID_ADDRESS=0x...  USDC_ADDRESS=0x...  IS_ETH_ASSET=true  KASH_YIELD_ADDRESS=0x...  \
//   npx hardhat run scripts/deploy-hyperliquid-adapter.js --network arbitrumOne
//
// Required env vars (HL **bridge**, not the adapter — use setHyperliquid.js for the adapter later):
//   HL_BRIDGE_ADDRESS or MOCK_HL_ADDRESS or HYPERLIQUID_ADDRESS — Bridge2 on Arbitrum
//   USDC_ADDRESS         — USDC address
//   WBTC_ADDRESS         — wBTC address (BTC product only; ignored when IS_ETH_ASSET=true)
//   KASH_YIELD_ADDRESS   — KashYieldETH or KashYieldBtc address (authorised to call capital-movement functions)
//
// Optional:
//   IS_ETH_ASSET=true    — set for the ETH product adapter (assetAddress = 0x0, isEthAsset = true)
//   HL_ADAPTER_LABEL     — label printed in output (e.g. "BTC" or "ETH", default: auto-detected)
//   HL_ADAPTER_OPERATOR_ADDRESS — bot EOA; after deploy, owner calls setOperator (syncBalances/syncPosition)

require("dotenv").config();
const hre = require("hardhat");
const fs  = require("fs");
const path = require("path");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network = hre.network.name;

  console.log("Deploying HyperliquidAdapter to", network);
  console.log("Deployer:", deployer.address);

  // Bridge2 on Arbitrum One (not the deployed HyperliquidAdapter — that goes to setHyperliquid.js later).
  const hlAddress =
    process.env.HL_BRIDGE_ADDRESS ||
    process.env.MOCK_HL_ADDRESS ||
    process.env.HYPERLIQUID_BRIDGE_ADDRESS ||
    process.env.HYPERLIQUID_ADDRESS;
  const usdcAddress      = process.env.USDC_ADDRESS;
  const wbtcAddress      = process.env.WBTC_ADDRESS;
  const isEth            = (process.env.IS_ETH_ASSET || "").toLowerCase() === "true";
  // Prefer the vault that matches the product — root .env often has both KASH_YIELD_ETH_ADDRESS and
  // KASH_YIELD_BTC_ADDRESS; a naive A || B || C would always pick ETH and break BTC adapter deploys.
  const kashYieldAddress = isEth
    ? (process.env.KASH_YIELD_ETH_ADDRESS || process.env.KASH_YIELD_ADDRESS)
    : (process.env.KASH_YIELD_BTC_ADDRESS || process.env.KASH_YIELD_ADDRESS);
  const label            = process.env.HL_ADAPTER_LABEL || (isEth ? "ETH" : "BTC");

  if (!hlAddress || !hre.ethers.isAddress(hlAddress)) {
    throw new Error(
      "Set HL bridge address — HL_BRIDGE_ADDRESS, MOCK_HL_ADDRESS, or HYPERLIQUID_ADDRESS " +
        "(Arbitrum One Bridge2: 0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7)."
    );
  }
  if (!usdcAddress || !hre.ethers.isAddress(usdcAddress)) {
    throw new Error("Set USDC_ADDRESS in .env.");
  }
  if (!kashYieldAddress || !hre.ethers.isAddress(kashYieldAddress)) {
    const hint = isEth
      ? "Set KASH_YIELD_ETH_ADDRESS (or KASH_YIELD_ADDRESS); use IS_ETH_ASSET=true."
      : "Set KASH_YIELD_BTC_ADDRESS (or KASH_YIELD_ADDRESS); use IS_ETH_ASSET=false so .env does not pick the ETH vault.";
    throw new Error("KashYield vault address missing or invalid — " + hint);
  }

  // For the ETH product the on-chain asset is native ETH, so assetAddress = 0x0.
  // For the BTC product assetAddress = wBTC ERC-20 contract.
  const assetAddress = isEth ? hre.ethers.ZeroAddress : wbtcAddress;
  if (!isEth && (!wbtcAddress || !hre.ethers.isAddress(wbtcAddress))) {
    throw new Error(
      "Set WBTC_ADDRESS in .env for the BTC adapter. " +
      "Or set IS_ETH_ASSET=true for the ETH product."
    );
  }

  console.log("\nParameters:");
  console.log("  Product:       ", label);
  console.log("  HL address:    ", hlAddress);
  console.log("  USDC:          ", usdcAddress);
  console.log("  Asset:         ", isEth ? "(native ETH)" : assetAddress);
  console.log("  isEthAsset:    ", isEth);
  console.log("  KashYield:     ", kashYieldAddress);
  console.log("");

  const HyperliquidAdapter = await hre.ethers.getContractFactory("HyperliquidAdapter");
  const adapter = await HyperliquidAdapter.deploy(hlAddress, usdcAddress, assetAddress, isEth, kashYieldAddress);
  await adapter.waitForDeployment();
  const adapterAddress = await adapter.getAddress();

  console.log(`✅ HyperliquidAdapter (${label}):`, adapterAddress);

  const operatorAddr =
    process.env.HL_ADAPTER_OPERATOR_ADDRESS ||
    process.env.HL_ADAPTER_OPERATOR ||
    process.env.HL_SYNC_OPERATOR_ADDRESS;
  if (operatorAddr && hre.ethers.isAddress(operatorAddr)) {
    const txOp = await adapter.setOperator(operatorAddr);
    await txOp.wait();
    console.log("✅ Adapter operator set (HL sync):", operatorAddr);
  }

  console.log("\n====================================");
  console.log(`📋 HYPERLIQUID ADAPTER (${label})`);
  console.log("====================================");
  console.log("  HyperliquidAdapter:", adapterAddress);
  console.log("  Wraps HL bridge:   ", hlAddress);
  console.log("  USDC:              ", usdcAddress);
  console.log("  Asset:             ", isEth ? "native ETH" : assetAddress);
  console.log("====================================");
  const envVarName = isEth ? "HL_ADAPTER_ADDRESS_ETH" : "HL_ADAPTER_ADDRESS_BTC";
  const kashYieldEnvVar = isEth ? "KASH_YIELD_ADDRESS" : "KASH_YIELD_BTC_ADDRESS";
  console.log("\nNext steps:");
  console.log("  1. Add to .env:");
  console.log(`       ${envVarName}=${adapterAddress}`);
  console.log("  2. Register the adapter on KashYield (first-time: immediate; subsequent: starts 24h timelock):");
  console.log(`       ${kashYieldEnvVar}=<contract> HYPERLIQUID_ADDRESS=${adapterAddress} npx hardhat run scripts/setHyperliquid.js --network ${network}`);
  console.log("  3. Activate HL as the live exchange (always immediate):");
  console.log(`       ${kashYieldEnvVar}=<contract> EXCHANGE_NAME=HL npx hardhat run scripts/setActivePerpExchange.js --network ${network}`);
  console.log("  (For 2nd+ adapter registrations, run confirmPerpExchange.js after the timelock before step 3)\n");

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
      hyperliquidBridge: hlAddress,
      usdc: usdcAddress,
      asset: assetAddress,
      isEthAsset: isEth,
      kashYield: kashYieldAddress,
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
