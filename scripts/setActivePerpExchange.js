// scripts/setActivePerpExchange.js
// Immediately sets the active perp exchange on KashYieldETH or KashYieldBtc.
// This is step 3 of 3 — run after confirmPerpExchange.js has succeeded.
//
// The adapter must already be confirmed (live in perpExchanges registry).
// No timelock: this call is immediate.
//
// This script is also used to switch between already-confirmed exchanges at any time
// (e.g. switch from HL to GMX after both adapters have been registered and confirmed).
//
// Usage (ETH product):
//   EXCHANGE_NAME=HL npx hardhat run scripts/setActivePerpExchange.js --network arbitrumSepolia
//
// Usage (BTC product):
//   KASH_YIELD_BTC_ADDRESS=0x... EXCHANGE_NAME=HL \
//   npx hardhat run scripts/setActivePerpExchange.js --network arbitrumSepolia

require("dotenv").config();
const hre = require("hardhat");

async function main() {
  const [signer] = await hre.ethers.getSigners();
  const network = hre.network.name;

  const exchangeName = process.env.EXCHANGE_NAME;
  if (!exchangeName) {
    throw new Error('Set EXCHANGE_NAME in env (e.g. EXCHANGE_NAME=HL). Must match the key used when registering the adapter.');
  }

  const kashYieldBtcAddress = process.env.KASH_YIELD_BTC_ADDRESS;
  const isBtc = kashYieldBtcAddress && hre.ethers.isAddress(kashYieldBtcAddress);
  const kashYieldAddress = isBtc ? kashYieldBtcAddress : process.env.KASH_YIELD_ADDRESS;
  const contractName = isBtc ? "KashYieldBtc" : "KashYieldETH";

  if (!kashYieldAddress || !hre.ethers.isAddress(kashYieldAddress)) {
    throw new Error(
      `Set KASH_YIELD_ADDRESS (ETH product) or KASH_YIELD_BTC_ADDRESS (BTC product) in .env.\n` +
      `Current value: "${kashYieldAddress}"`
    );
  }

  console.log("Network:         ", network);
  console.log(`${contractName}:  `, kashYieldAddress);
  console.log("Exchange name:   ", exchangeName);
  console.log("Signer:          ", signer.address);

  const kashYield = await hre.ethers.getContractAt(contractName, kashYieldAddress);

  const owner = await kashYield.owner();
  if (signer.address.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(`Signer ${signer.address} is not the contract owner (${owner})`);
  }

  // Verify the adapter is registered before trying to activate it
  const adapterAddr = await kashYield.perpExchanges(exchangeName);
  if (!adapterAddr || adapterAddr === hre.ethers.ZeroAddress) {
    throw new Error(
      `Exchange "${exchangeName}" is not registered (perpExchanges["${exchangeName}"] = 0x0).\n` +
      `Run confirmPerpExchange.js first to complete the adapter registration.`
    );
  }

  const currentActive = await kashYield.activePerpExchange();
  console.log("\nCurrent active exchange:", currentActive || "(none)");
  console.log(`Setting active exchange to "${exchangeName}"...`);

  const tx = await kashYield.setActivePerpExchange(exchangeName);
  console.log("  Tx:", tx.hash);
  await tx.wait();

  const newActive = await kashYield.activePerpExchange();
  console.log(`\n✅ Active exchange set!`);
  console.log(`  activePerpExchange: "${newActive}"`);
  console.log(`  Adapter address:    ${adapterAddr}`);
  console.log("\nAll exchange calls will now route through this adapter.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
