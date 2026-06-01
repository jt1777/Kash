// scripts/setCycleDuration.js
// Set the batch cycle duration and matching time-window boundaries on KashYieldBtc / KashYieldETH.
// Only the owner can call. Min 60 seconds.
//
// Window logic applied automatically:
//   Production (86400 s / 1 day) → user window = 0–85500 s (23 h 45 m), processing = last 15 min.
//   Any shorter cycle (e.g. 3600 for testing) → windows disabled (open the entire cycle).
//   Override with USER_WINDOW_END and PROCESSING_WINDOW_START env vars if needed.
//
// Usage (from repo root):
//   CYCLE_SECONDS=86400 npx hardhat run scripts/setCycleDuration.js --network arbitrumSepolia
//   CYCLE_SECONDS=3600  PRODUCT=eth npx hardhat run scripts/setCycleDuration.js --network arbitrumSepolia
//
// Env (root .env):
//   CYCLE_SECONDS            - duration in seconds (required). e.g. 3600 = 1 hour, 86400 = 1 day
//   PRODUCT                  - "btc" | "eth" | "both" (default: both)
//   USER_WINDOW_END          - optional override (seconds into cycle when user window closes)
//   PROCESSING_WINDOW_START  - optional override (seconds into cycle when bot window opens)
//   KASH_YIELD_BTC_ADDRESS, KASH_YIELD_ETH_ADDRESS - contract addresses
//   PRIVATE_KEY              - owner wallet

require("dotenv").config();
const hre = require("hardhat");

const PRODUCTION_CYCLE = 86400n;
const DEFAULT_USER_WINDOW_END = 23n * 3600n + 45n * 60n; // 85500 s

async function main() {
  const raw = process.env.CYCLE_SECONDS;
  if (!raw || isNaN(Number(raw))) {
    throw new Error("Set CYCLE_SECONDS=<number> in env (e.g. CYCLE_SECONDS=86400 for 1 day).");
  }
  const seconds = BigInt(raw);
  if (seconds < 60n) {
    throw new Error("CYCLE_SECONDS must be at least 60.");
  }

  // Derive window boundaries.
  // For a 24-hour production cycle use the 23h50m/10m split; for anything shorter open both windows.
  const isProduction = seconds >= PRODUCTION_CYCLE;
  const userWindowEnd = process.env.USER_WINDOW_END
    ? BigInt(process.env.USER_WINDOW_END)
    : isProduction ? DEFAULT_USER_WINDOW_END : seconds;          // disabled = full cycle
  const processingWindowStart = process.env.PROCESSING_WINDOW_START
    ? BigInt(process.env.PROCESSING_WINDOW_START)
    : isProduction ? DEFAULT_USER_WINDOW_END : 0n;               // disabled = start of cycle

  const product = (process.env.PRODUCT || "both").toLowerCase();
  const [signer] = await hre.ethers.getSigners();

  const label = seconds === 86400n ? "1 day" : seconds === 3600n ? "1 hour" : `${seconds} s`;
  console.log(`Cycle duration : ${seconds} s (${label})`);
  console.log(`User window    : 0 – ${userWindowEnd} s`);
  console.log(`Processing win : ${processingWindowStart} – ${seconds} s`);
  console.log(`Product(s)     : ${product}\n`);

  async function configure(contractName, addr) {
    if (!addr || !hre.ethers.isAddress(addr)) {
      throw new Error(`Set address in .env for ${contractName}.`);
    }
    const kashYield = await hre.ethers.getContractAt(contractName, addr);
    const owner = await kashYield.owner();
    if (signer.address.toLowerCase() !== owner.toLowerCase()) {
      throw new Error(`Signer ${signer.address} is not owner of ${contractName} (${owner}).`);
    }

    let tx = await kashYield.setCycleDurationSeconds(seconds);
    await tx.wait();
    tx = await kashYield.setUserWindowEnd(userWindowEnd);
    await tx.wait();
    tx = await kashYield.setProcessingWindowStart(processingWindowStart);
    await tx.wait();

    console.log(`  ${contractName} (${addr}):`);
    console.log(`    cycleDurationSeconds    = ${seconds}`);
    console.log(`    userWindowEnd           = ${userWindowEnd}`);
    console.log(`    processingWindowStart   = ${processingWindowStart}`);
  }

  if (product === "btc" || product === "both") {
    await configure("KashYieldBtc", process.env.KASH_YIELD_BTC_ADDRESS || process.env.KASH_YIELD_ADDRESS);
  }

  if (product === "eth" || product === "both") {
    await configure("KashYieldETH", process.env.KASH_YIELD_ETH_ADDRESS || process.env.KASH_YIELD_ADDRESS);
  }

  console.log("\nDone.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
