// scripts/confirmPerpExchange.js
// Confirms the pending adapter registration after the 48-hour timelock expires.
// This is step 2 of 3 — run after setHyperliquid.js (or setPerpExchange for other exchanges).
//
// After this script succeeds, the adapter is live in the perpExchanges registry.
// Then run setActivePerpExchange.js (step 3) to make it the active exchange.
//
// Usage (ETH product):
//   EXCHANGE_NAME=HL npx hardhat run scripts/confirmPerpExchange.js --network arbitrumSepolia
//
// Usage (BTC product):
//   KASH_YIELD_BTC_ADDRESS=0x... EXCHANGE_NAME=HL \
//   npx hardhat run scripts/confirmPerpExchange.js --network arbitrumSepolia
//
// For Hardhat local/testnet testing (fast-forward past the 48h timelock):
//   await network.provider.send("evm_increaseTime", [48 * 3600 + 1]);
//   await network.provider.send("evm_mine");

require("dotenv").config();
const hre = require("hardhat");

async function main() {
  const [signer] = await hre.ethers.getSigners();
  const network = hre.network.name;

  const exchangeName = process.env.EXCHANGE_NAME;
  if (!exchangeName) {
    throw new Error('Set EXCHANGE_NAME in env (e.g. EXCHANGE_NAME=HL). This is the key used when registering the adapter.');
  }

  const productEnv = (process.env.PRODUCT || "").toLowerCase();
  const kashYieldBtcAddress = process.env.KASH_YIELD_BTC_ADDRESS;
  const kashYieldEthAddress = process.env.KASH_YIELD_ETH_ADDRESS || process.env.KASH_YIELD_ADDRESS;
  const isBtc =
    productEnv === "btc" ||
    (productEnv !== "eth" &&
      kashYieldBtcAddress &&
      hre.ethers.isAddress(kashYieldBtcAddress) &&
      !kashYieldEthAddress);
  const kashYieldAddress = isBtc ? kashYieldBtcAddress : kashYieldEthAddress;
  const contractName = isBtc ? "KashYieldBtc" : "KashYieldETH";

  if (!kashYieldAddress || !hre.ethers.isAddress(kashYieldAddress)) {
    throw new Error(
      `Set KASH_YIELD_ETH_ADDRESS (ETH product) or KASH_YIELD_BTC_ADDRESS (BTC product) in .env.\n` +
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

  // Check timelock state
  const readyAt = await kashYield.adapterReadyAt(exchangeName);
  const readyAtNum = BigInt(readyAt.toString());
  const now = BigInt(Math.floor(Date.now() / 1000));

  if (readyAtNum === 0n) {
    throw new Error(
      `No pending adapter proposal for "${exchangeName}".\n` +
      `Run setHyperliquid.js (for HL) or setPerpExchange.js to propose an adapter first.`
    );
  }

  if (now < readyAtNum) {
    const waitSecs = Number(readyAtNum - now);
    const waitHours = (waitSecs / 3600).toFixed(1);
    throw new Error(
      `Timelock not expired yet. Ready at ${new Date(Number(readyAtNum) * 1000).toISOString()} ` +
      `(${waitHours} hours from now).\n\n` +
      `For testing, fast-forward time with:\n` +
      `  await network.provider.send("evm_increaseTime", [${waitSecs + 1}]);\n` +
      `  await network.provider.send("evm_mine");`
    );
  }

  console.log(`\nConfirming "${exchangeName}" adapter registration...`);
  const tx = await kashYield.confirmPerpExchange(exchangeName);
  console.log("  Tx:", tx.hash);
  await tx.wait();

  const registeredAddr = await kashYield.perpExchanges(exchangeName);
  console.log(`\n✅ Adapter confirmed!`);
  console.log(`  perpExchanges["${exchangeName}"] =`, registeredAddr);

  console.log("\nNext step — activate this exchange:");
  console.log(`  ${isBtc ? `KASH_YIELD_BTC_ADDRESS=${kashYieldAddress} ` : `KASH_YIELD_ETH_ADDRESS=${kashYieldAddress} `}\\`);
  console.log(`  EXCHANGE_NAME=${exchangeName} npx hardhat run scripts/setActivePerpExchange.js --network ${network}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
