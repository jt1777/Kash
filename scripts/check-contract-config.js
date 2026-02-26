// scripts/check-contract-config.js
// Reads KashYieldETH's hyperliquidAddress and aavePoolAddress and verifies they match expected.
// Usage: npx hardhat run scripts/check-contract-config.js --network arbitrumSepolia
// Requires KASH_YIELD_ADDRESS in .env (or pass as env).

const hre = require("hardhat");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const KASH_YIELD_ADDRESS =
  process.env.KASH_YIELD_ADDRESS || "0xf78854a9B5D28DdB1B35a60553e22481fE87d759";

// Expected Arbitrum Sepolia addresses (from contract / docs)
const EXPECTED_AAVE_POOL = "0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff";
const EXPECTED_MOCK_HL = "0xED3B4689D1b5DAD6619c9bf450DCE1d00F46BaD3";

async function main() {
  console.log("KashYieldETH at:", KASH_YIELD_ADDRESS);
  console.log("Network:", hre.network.name, "\n");

  const kashYield = await hre.ethers.getContractAt("KashYieldETH", KASH_YIELD_ADDRESS);

  const aavePool = await kashYield.aavePoolAddress();
  const hyperliquid = await kashYield.hyperliquidAddress();

  console.log("=== Contract config (on-chain) ===");
  console.log("  aavePoolAddress:   ", aavePool);
  console.log("  hyperliquidAddress:", hyperliquid || "(zero)");
  console.log("");

  let ok = true;

  if (aavePool.toLowerCase() !== EXPECTED_AAVE_POOL.toLowerCase()) {
    console.log("⚠️  Aave pool mismatch. Expected (Arbitrum Sepolia):", EXPECTED_AAVE_POOL);
    ok = false;
  } else {
    console.log("✅ Aave pool matches expected Arbitrum Sepolia pool:", EXPECTED_AAVE_POOL);
  }

  if (!hyperliquid || hyperliquid === hre.ethers.ZeroAddress) {
    console.log("⚠️  Hyperliquid address is not set on the contract.");
    ok = false;
  } else if (hyperliquid.toLowerCase() !== EXPECTED_MOCK_HL.toLowerCase()) {
    console.log("⚠️  Hyperliquid differs from your deployed mock. Expected:", EXPECTED_MOCK_HL);
    ok = false;
  } else {
    console.log("✅ Hyperliquid matches deployed MockHyperliquid:", EXPECTED_MOCK_HL);
  }

  if (hyperliquid && hyperliquid !== hre.ethers.ZeroAddress) {
    const code = await hre.ethers.provider.getCode(hyperliquid);
    if (!code || code === "0x") {
      console.log("⚠️  No contract code at hyperliquidAddress (wrong network or not deployed).");
      ok = false;
    } else {
      console.log("✅ Contract exists at hyperliquidAddress (bytecode length:", code.length, ")");
    }
  }

  console.log("");
  if (ok) {
    console.log("✅ Config check passed: contract is reading the correct Aave pool and Hyperliquid mock.");
  } else {
    console.log("❌ Some checks failed. Update contract via setAavePool/setHyperliquid if needed.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
