// scripts/ownerManuallyProcessRedeem.js
// Atomically processes all orphaned redeem requests for a given batch cycle.
// For each user: burns their KASH held by the contract AND sends them their wBTC/ETH.
//
// All payouts happen in a single transaction — if the contract has insufficient funds
// for any user the entire tx reverts, so there are never partial payouts.
//
// Prerequisites: the contract must hold enough wBTC (or ETH) to cover all redemptions.
// Run ownerWithdrawFromAave.js (and HL unwind scripts) first if needed.
//
// Usage (from repo root):
//   BATCH_CYCLE=20523 USER_ADDRESSES=0xAAA,0xBBB,0xCCC npx hardhat run scripts/ownerManuallyProcessRedeem.js --network arbitrumSepolia
//
// Single user:
//   BATCH_CYCLE=20523 USER_ADDRESSES=0xAAA npx hardhat run scripts/ownerManuallyProcessRedeem.js --network arbitrumSepolia
//
// Env (root .env):
//   PRIVATE_KEY               - owner wallet
//   KASH_YIELD_BTC_ADDRESS    - KashYieldBtc contract (or KASH_YIELD_ETH_ADDRESS for ETH)
//   PRODUCT                   - "btc" (default) or "eth"
//   BATCH_CYCLE               - the stuck batch cycle number (required)
//   USER_ADDRESSES            - comma-separated list of user addresses to process (required)

require("dotenv").config();
const hre = require("hardhat");

const KASH_DECIMALS = 18;
const WBTC_DECIMALS = 8;

async function main() {
  const product = (process.env.PRODUCT || "btc").toLowerCase();
  const kashYieldAddress =
    product === "btc"
      ? process.env.KASH_YIELD_BTC_ADDRESS || process.env.KASH_YIELD_ADDRESS
      : process.env.KASH_YIELD_ETH_ADDRESS || process.env.KASH_YIELD_ADDRESS;

  if (!kashYieldAddress || !hre.ethers.isAddress(kashYieldAddress)) {
    throw new Error("Set KASH_YIELD_BTC_ADDRESS (or KASH_YIELD_ETH_ADDRESS) in .env.");
  }

  const batchCycleRaw = process.env.BATCH_CYCLE;
  if (!batchCycleRaw || isNaN(Number(batchCycleRaw))) {
    throw new Error("Set BATCH_CYCLE=<number> in env (e.g. BATCH_CYCLE=20523).");
  }
  const batchCycle = BigInt(batchCycleRaw);

  const userAddressesRaw = process.env.USER_ADDRESSES;
  if (!userAddressesRaw) {
    throw new Error("Set USER_ADDRESSES=0xAAA,0xBBB,... in env (comma-separated).");
  }
  const users = userAddressesRaw.split(",").map((a) => a.trim());
  for (const addr of users) {
    if (!hre.ethers.isAddress(addr)) {
      throw new Error(`Invalid address: ${addr}`);
    }
  }

  const [signer] = await hre.ethers.getSigners();
  const contractName = product === "eth" ? "KashYieldETH" : "KashYieldBtc";
  const kashYield = await hre.ethers.getContractAt(contractName, kashYieldAddress);

  const owner = await kashYield.owner();
  if (signer.address.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(`Signer ${signer.address} is not the contract owner (${owner}).`);
  }

  const assetSymbol = product === "btc" ? "wBTC" : "ETH";
  console.log(`Manually processing ${users.length} orphaned redeem request(s)`);
  console.log(`  Contract:   ${kashYieldAddress}`);
  console.log(`  Batch cycle: ${batchCycle}`);
  console.log(`  Users:      ${users.join(", ")}`);

  // Preview each user's pending request
  for (const addr of users) {
    const req = await kashYield.getPendingRedeemRequest(addr, batchCycle);
    if (!req || req.kashAmount === 0n) {
      throw new Error(`No pending redeem request for ${addr} in cycle ${batchCycle}. Aborting.`);
    }
    const kashHuman = hre.ethers.formatUnits(req.kashAmount, KASH_DECIMALS);
    console.log(`  ${addr}: ${kashHuman} KASH to burn → ${assetSymbol} payout`);
  }

  console.log(`\nSending single atomic transaction for all ${users.length} user(s)...`);

  const tx = await kashYield.ownerManuallyProcessRedeem(users, batchCycle);
  console.log(`Tx hash: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`✅ Confirmed in block ${receipt.blockNumber}`);
  console.log(`   All KASH burned and ${assetSymbol} sent atomically. No partial payouts possible.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
