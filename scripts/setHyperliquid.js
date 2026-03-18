// scripts/setHyperliquid.js
// Proposes registering the HyperliquidAdapter on KashYieldETH or KashYieldBtc.
// This is step 1 of 3 in the adapter setup flow:
//
//   Step 1 (this script): setHyperliquid(adapterAddress)  — starts 48h timelock
//   Step 2:               confirmPerpExchange.js "HL"      — after 48h; adapter goes live in registry
//   Step 3:               setActivePerpExchange.js "HL"    — immediately makes HL the active exchange
//
// IMPORTANT: HYPERLIQUID_ADDRESS must be the deployed HyperliquidAdapter address.
// Deploy the adapter first: npx hardhat run scripts/deploy-hyperliquid-adapter.js
//
// Usage (ETH product):
//   HYPERLIQUID_ADDRESS=0x<adapter> npx hardhat run scripts/setHyperliquid.js --network arbitrumSepolia
//
// Usage (BTC product):
//   KASH_YIELD_BTC_ADDRESS=0x<kashYieldBtc> HYPERLIQUID_ADDRESS=0x<adapter> \
//   npx hardhat run scripts/setHyperliquid.js --network arbitrumSepolia

require("dotenv").config();
const hre = require("hardhat");

async function main() {
  // Explicit PRODUCT=eth|btc overrides auto-detection.
  // Auto-detection: BTC only if KASH_YIELD_BTC_ADDRESS is set AND KASH_YIELD_ADDRESS is not.
  const productEnv = (process.env.PRODUCT || "").toLowerCase();
  const kashYieldBtcAddress = process.env.KASH_YIELD_BTC_ADDRESS;
  const kashYieldEthAddress = process.env.KASH_YIELD_ADDRESS;
  const isBtc =
    productEnv === "btc" ||
    (productEnv !== "eth" &&
      kashYieldBtcAddress &&
      hre.ethers.isAddress(kashYieldBtcAddress) &&
      !kashYieldEthAddress);

  // Product-specific name takes priority over the generic HYPERLIQUID_ADDRESS
  const HYPERLIQUID_ADDRESS =
    (isBtc ? process.env.HL_ADAPTER_ADDRESS_BTC : process.env.HL_ADAPTER_ADDRESS_ETH) ||
    process.env.HYPERLIQUID_ADDRESS ||
    "";

  if (!HYPERLIQUID_ADDRESS || HYPERLIQUID_ADDRESS === "0x...") {
    throw new Error(
      "Set HYPERLIQUID_ADDRESS in .env to the deployed HyperliquidAdapter address.\n" +
      "Deploy the adapter first: npx hardhat run scripts/deploy-hyperliquid-adapter.js"
    );
  }
  if (!hre.ethers.isAddress(HYPERLIQUID_ADDRESS)) {
    throw new Error("Invalid HYPERLIQUID_ADDRESS: " + HYPERLIQUID_ADDRESS);
  }

  const kashYieldAddress = isBtc ? kashYieldBtcAddress : kashYieldEthAddress;
  const contractName = isBtc ? "KashYieldBtc" : "KashYieldETH";

  if (!kashYieldAddress || !hre.ethers.isAddress(kashYieldAddress)) {
    throw new Error(
      `Set ${isBtc ? "KASH_YIELD_BTC_ADDRESS" : "KASH_YIELD_ADDRESS"} in .env.\n` +
      `Current value: "${kashYieldAddress}"`
    );
  }

  const network = hre.network.name;
  console.log("Network:         ", network);
  console.log(`${contractName}:  `, kashYieldAddress);
  console.log("Adapter address: ", HYPERLIQUID_ADDRESS);

  const kashYield = await hre.ethers.getContractAt(contractName, kashYieldAddress);
  const [signer] = await hre.ethers.getSigners();
  const owner = await kashYield.owner();

  if (signer.address.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(`Signer ${signer.address} is not the contract owner (${owner})`);
  }

  console.log("\nRegistering HyperliquidAdapter...");
  const tx = await kashYield.setHyperliquid(HYPERLIQUID_ADDRESS);
  console.log("  Tx:", tx.hash);
  await tx.wait();

  // Detect which path was taken: immediate (first-time) or timelocked (subsequent)
  const readyAt = await kashYield.adapterReadyAt("HL");
  const registeredAddr = await kashYield.perpExchanges("HL");
  const contractVar = isBtc ? `KASH_YIELD_BTC_ADDRESS=${kashYieldAddress}` : `KASH_YIELD_ADDRESS=${kashYieldAddress}`;

  if (registeredAddr !== hre.ethers.ZeroAddress && BigInt(readyAt.toString()) === 0n) {
    // First-time bypass: adapter is already live
    console.log("  ✅ First-time registration: adapter confirmed immediately (no timelock).");
    console.log("  perpExchanges[\"HL\"] =", registeredAddr);
    console.log("\n====================================");
    console.log("NEXT STEP");
    console.log("====================================");
    console.log("  Activate HL as the live exchange (immediate, no delay):");
    console.log(`    ${contractVar} \\`);
    console.log(`    EXCHANGE_NAME=HL npx hardhat run scripts/setActivePerpExchange.js --network ${network}`);
    console.log("====================================\n");
  } else {
    // Timelocked path
    const readyAtDate = new Date(Number(readyAt) * 1000).toISOString();
    console.log("  ✅ Adapter proposed. Timelock expires:", readyAtDate);
    console.log("\n====================================");
    console.log("NEXT STEPS");
    console.log("====================================");
    console.log(`  Timelock expires at: ${readyAtDate}`);
    console.log("");
    console.log("  Step 2 — After 48 hours, confirm the adapter registration:");
    console.log(`    ${contractVar} \\`);
    console.log(`    EXCHANGE_NAME=HL npx hardhat run scripts/confirmPerpExchange.js --network ${network}`);
    console.log("");
    console.log("  Step 3 — Immediately activate HL as the live exchange:");
    console.log(`    ${contractVar} \\`);
    console.log(`    EXCHANGE_NAME=HL npx hardhat run scripts/setActivePerpExchange.js --network ${network}`);
    console.log("");
    console.log("  For Hardhat local/testnet testing, fast-forward time with:");
    console.log('    await network.provider.send("evm_increaseTime", [48 * 3600 + 1]);');
    console.log('    await network.provider.send("evm_mine");');
    console.log("====================================\n");
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
