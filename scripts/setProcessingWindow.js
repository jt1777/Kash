/**
 * setProcessingWindow — Configure the batch processing window and user submission window.
 *
 * The contract enforces two time windows within each 24-hour cycle:
 *   userWindowEnd         — users cannot requestMint/requestRedeem after this second-of-day
 *   processingWindowStart — bot cannot run Phase 1 / Phase 2 before this second-of-day
 *
 * Production defaults (seconds from UTC midnight):
 *   userWindowEnd         = 85500  (23:45:00 UTC — user submissions close; processing begins)
 *   processingWindowStart = 85500  (23:45:00 UTC — bot processes in the last 15 min)
 *
 * To DISABLE windowing for testing (bot can process any time, users can submit any time):
 *   PROCESSING_WINDOW_START=0 USER_WINDOW_END=86400 \
 *     npx hardhat run scripts/setProcessingWindow.js --network arbitrumOne
 *
 * To RESTORE production defaults:
 *   PROCESSING_WINDOW_START=85500 USER_WINDOW_END=85500 \
 *     npx hardhat run scripts/setProcessingWindow.js --network arbitrumOne
 *
 * You can also set just one value by omitting the other env var.
 */
require("dotenv").config();
const hre = require("hardhat");

async function main() {
  const kashYieldEthAddr = process.env.KASH_YIELD_ETH_ADDRESS || process.env.KASH_YIELD_ADDRESS;
  const kashYieldBtcAddr = process.env.KASH_YIELD_BTC_ADDRESS;
  const productEnv = (process.env.PRODUCT || "").toLowerCase();

  const isBtc =
    productEnv === "btc" ||
    (productEnv !== "eth" && kashYieldBtcAddr && hre.ethers.isAddress(kashYieldBtcAddr) && !kashYieldEthAddr);

  const kashYieldAddress = isBtc ? kashYieldBtcAddr : kashYieldEthAddr;
  const contractName = isBtc ? "KashYieldBtc" : "KashYieldETH";

  if (!kashYieldAddress || !hre.ethers.isAddress(kashYieldAddress)) {
    throw new Error("Set KASH_YIELD_ETH_ADDRESS (ETH) or KASH_YIELD_BTC_ADDRESS (BTC) in .env");
  }

  const processingWindowStart = process.env.PROCESSING_WINDOW_START !== undefined
    ? Number(process.env.PROCESSING_WINDOW_START)
    : null;
  const userWindowEnd = process.env.USER_WINDOW_END !== undefined
    ? Number(process.env.USER_WINDOW_END)
    : null;

  if (processingWindowStart === null && userWindowEnd === null) {
    throw new Error(
      "Set at least one of PROCESSING_WINDOW_START or USER_WINDOW_END.\n" +
      "  Disable windowing: PROCESSING_WINDOW_START=0 USER_WINDOW_END=86400\n" +
      "  Restore defaults:  PROCESSING_WINDOW_START=85500 USER_WINDOW_END=85500"
    );
  }

  const [signer] = await hre.ethers.getSigners();
  const kashYield = await hre.ethers.getContractAt(contractName, kashYieldAddress);
  const owner = await kashYield.owner();

  if (signer.address.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(`Signer ${signer.address} is not owner (owner: ${owner}).`);
  }

  const currentPws  = await kashYield.processingWindowStart();
  const currentUwe  = await kashYield.userWindowEnd();
  const cycleSecs   = await kashYield.cycleDurationSeconds();

  console.log("Network:       ", hre.network.name);
  console.log(`${contractName}:`, kashYieldAddress);
  console.log(`cycleDurationSeconds: ${cycleSecs}`);
  console.log(`Current processingWindowStart: ${currentPws} (${formatHhMm(Number(currentPws))} UTC)`);
  console.log(`Current userWindowEnd:         ${currentUwe} (${formatHhMm(Number(currentUwe))} UTC)`);
  console.log("");

  if (processingWindowStart !== null) {
    if (processingWindowStart === 0) {
      console.log("⚠️  Setting processingWindowStart=0 disables the processing window (bot runs any time).");
      console.log("   Remember to restore to 85500 before going live with real users.");
    }
    const tx = await kashYield.setProcessingWindowStart(processingWindowStart);
    console.log(`setProcessingWindowStart(${processingWindowStart}) tx: ${tx.hash}`);
    await tx.wait();
    console.log(`✅ processingWindowStart → ${processingWindowStart} (${formatHhMm(processingWindowStart)} UTC)`);
  }

  if (userWindowEnd !== null) {
    const tx = await kashYield.setUserWindowEnd(userWindowEnd);
    console.log(`setUserWindowEnd(${userWindowEnd}) tx: ${tx.hash}`);
    await tx.wait();
    console.log(`✅ userWindowEnd → ${userWindowEnd} (${formatHhMm(userWindowEnd)} UTC)`);
  }
}

function formatHhMm(seconds) {
  if (seconds === 0) return "00:00 (disabled — always open)";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
