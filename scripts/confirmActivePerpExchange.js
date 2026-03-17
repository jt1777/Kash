// scripts/confirmActivePerpExchange.js
// Confirms the pending active perp exchange switch on KashYieldBtc or KashYieldETH.
// Must be run at least 48 hours after proposeActivePerpExchange() was called
// (which happens automatically at the end of setHyperliquid.js).
//
// Usage (ETH product):
//   npx hardhat run scripts/confirmActivePerpExchange.js --network arbitrumSepolia
//
// Usage (BTC product):
//   KASH_YIELD_BTC_ADDRESS=0x... npx hardhat run scripts/confirmActivePerpExchange.js --network arbitrumSepolia
//
// For Hardhat local/testnet testing (fast-forward past the 48h timelock):
//   In your test or in the Hardhat console:
//     await network.provider.send("evm_increaseTime", [48 * 3600 + 1]);
//     await network.provider.send("evm_mine");
//   Then run this script (or call confirmActivePerpExchange() directly).

require("dotenv").config();
const hre = require("hardhat");

async function main() {
  const [signer] = await hre.ethers.getSigners();
  const network = hre.network.name;

  const kashYieldBtcAddress = process.env.KASH_YIELD_BTC_ADDRESS;
  const isBtc = kashYieldBtcAddress && hre.ethers.isAddress(kashYieldBtcAddress);
  const kashYieldAddress = isBtc
    ? kashYieldBtcAddress
    : process.env.KASH_YIELD_ADDRESS;
  const contractName = isBtc ? "KashYieldBtc" : "KashYieldETH";

  if (!kashYieldAddress || !hre.ethers.isAddress(kashYieldAddress)) {
    throw new Error(
      `Set KASH_YIELD_ADDRESS (ETH product) or KASH_YIELD_BTC_ADDRESS (BTC product) in .env.\n` +
      `Current value: "${kashYieldAddress}"`
    );
  }

  console.log("Network:     ", network);
  console.log(`${contractName}:`, kashYieldAddress);
  console.log("Signer:      ", signer.address);

  const kashYield = await hre.ethers.getContractAt(contractName, kashYieldAddress);

  const owner = await kashYield.owner();
  if (signer.address.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(`Signer ${signer.address} is not the contract owner (${owner})`);
  }

  // Check timelock state
  const readyAt = await kashYield.exchangeSwitchReadyAt();
  const readyAtNum = BigInt(readyAt.toString());
  const now = BigInt(Math.floor(Date.now() / 1000));

  if (readyAtNum === 0n) {
    throw new Error(
      "No active exchange switch proposed. " +
      "Run setHyperliquid.js first to register and propose the exchange."
    );
  }

  if (now < readyAtNum) {
    const waitSecs = Number(readyAtNum - now);
    const waitHours = (waitSecs / 3600).toFixed(1);
    throw new Error(
      `Timelock not expired yet. Ready at ${new Date(Number(readyAtNum) * 1000).toISOString()} ` +
      `(${waitHours} hours from now).\n` +
      `For testing: fast-forward time with:\n` +
      `  await network.provider.send("evm_increaseTime", [${waitSecs + 1}]);\n` +
      `  await network.provider.send("evm_mine");`
    );
  }

  const currentActive = await kashYield.activePerpExchange();
  console.log("\nCurrent active exchange:", currentActive || "(none)");
  console.log("Confirming pending switch...");

  const tx = await kashYield.confirmActivePerpExchange();
  console.log("Transaction sent:", tx.hash);
  await tx.wait();

  const newActive = await kashYield.activePerpExchange();
  const adapterAddr = await kashYield.perpExchanges(newActive);
  console.log("\n✅ Active exchange confirmed!");
  console.log("  Active exchange:", newActive);
  console.log("  Adapter address:", adapterAddr);
  console.log("\nThe contract will now route all exchange calls through the", newActive, "adapter.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
