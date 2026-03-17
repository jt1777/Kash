// scripts/setHyperliquid.js
// Registers a HyperliquidAdapter on KashYieldETH or KashYieldBtc and proposes
// it as the active perp exchange (step 1 of 2 in the timelock flow).
//
// IMPORTANT: HYPERLIQUID_ADDRESS must be the address of the deployed HyperliquidAdapter
// contract — NOT MockHyperliquid or the raw HL bridge directly.
// Deploy the adapter first with: scripts/deploy-hyperliquid-adapter.js
//
// Usage (ETH product):
//   HYPERLIQUID_ADDRESS=0x<adapter> npx hardhat run scripts/setHyperliquid.js --network arbitrumSepolia
//
// Usage (BTC product):
//   KASH_YIELD_BTC_ADDRESS=0x<kashYieldBtc> HYPERLIQUID_ADDRESS=0x<adapter> \
//   npx hardhat run scripts/setHyperliquid.js --network arbitrumSepolia
//
// After running this script:
//   - The adapter is registered in perpExchanges["HL"]
//   - A 48-hour timelock switch to "HL" has been proposed
//   - Wait 48 hours (or fast-forward in tests), then run:
//       npx hardhat run scripts/confirmActivePerpExchange.js --network arbitrumSepolia
//
// To disable Hyperliquid:
//   Set HYPERLIQUID_ADDRESS to 0x0000000000000000000000000000000000000000
//   and run: owner calls setHyperliquid(address(0)) directly (no proposeActivePerpExchange needed)

require("dotenv").config();
const hre = require("hardhat");

async function main() {
  const HYPERLIQUID_ADDRESS = process.env.HYPERLIQUID_ADDRESS || "";
  const kashYieldBtcAddress = process.env.KASH_YIELD_BTC_ADDRESS;
  const isBtc = kashYieldBtcAddress && hre.ethers.isAddress(kashYieldBtcAddress);

  if (!HYPERLIQUID_ADDRESS || HYPERLIQUID_ADDRESS === "0x...") {
    throw new Error(
      "Set HYPERLIQUID_ADDRESS in .env to the deployed HyperliquidAdapter address.\n" +
      "Deploy the adapter first: npx hardhat run scripts/deploy-hyperliquid-adapter.js"
    );
  }
  if (!hre.ethers.isAddress(HYPERLIQUID_ADDRESS)) {
    throw new Error("Invalid HYPERLIQUID_ADDRESS: " + HYPERLIQUID_ADDRESS);
  }

  const kashYieldAddress = isBtc
    ? kashYieldBtcAddress
    : process.env.KASH_YIELD_ADDRESS;
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

  // Step 1: Register the adapter under the "HL" key
  console.log("\nStep 1: Registering HyperliquidAdapter as 'HL' exchange...");
  const tx1 = await kashYield.setHyperliquid(HYPERLIQUID_ADDRESS);
  console.log("  Tx:", tx1.hash);
  await tx1.wait();
  const registered = await kashYield.perpExchanges("HL");
  console.log("  ✅ perpExchanges['HL'] =", registered);

  // Step 2: Propose switching the active exchange to "HL"
  console.log("\nStep 2: Proposing 'HL' as the active perp exchange (starts 48h timelock)...");
  const tx2 = await kashYield.proposeActivePerpExchange("HL");
  console.log("  Tx:", tx2.hash);
  await tx2.wait();

  const readyAt = await kashYield.exchangeSwitchReadyAt();
  const readyAtDate = new Date(Number(readyAt) * 1000).toISOString();
  console.log("  ✅ Exchange switch proposed. Ready at:", readyAtDate);

  console.log("\n====================================");
  console.log("ACTION REQUIRED: Confirm after timelock");
  console.log("====================================");
  console.log(`  The 48-hour timelock expires at: ${readyAtDate}`);
  console.log("  After that, run:");
  console.log(`    KASH_YIELD_${isBtc ? "BTC_" : ""}ADDRESS=${kashYieldAddress} \\`);
  console.log(`    npx hardhat run scripts/confirmActivePerpExchange.js --network ${network}`);
  console.log("");
  console.log("  For Hardhat local/testnet testing, fast-forward time with:");
  console.log('    await network.provider.send("evm_increaseTime", [48 * 3600 + 1]);');
  console.log('    await network.provider.send("evm_mine");');
  console.log("====================================\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
