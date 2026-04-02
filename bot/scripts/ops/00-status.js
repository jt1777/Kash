/**
 * 00-status — Show full position and balance snapshot.
 *
 * Usage:
 *   PRODUCT=eth npx hardhat run bot/scripts/ops/00-status.js --network arbitrumSepolia
 *   PRODUCT=btc npx hardhat run bot/scripts/ops/00-status.js --network arbitrumSepolia
 */
const { ethers } = require("hardhat");
const { getContract, getState, displayState, getRedeemFraction, PRODUCT } = require("./_utils");

async function main() {
  console.log(`\nKashYield Status  [product=${PRODUCT.toUpperCase()}]`);
  const contract = await getContract();
  const state = await getState(contract);
  displayState(state, "Current State");
  console.log(`\nContract address: ${state.addr}`);

  // If batch is in Phase 1 (ops pending), show the derived redeem fraction
  if (state.batchPhase === 1) {
    try {
      const { pct, redeemKash, totalSupply } = await getRedeemFraction(contract, state.batchCycle);
      console.log(`\nPhase 1 batch in progress — redeem ops parameters:`);
      console.log(`  Redeem KASH  : ${ethers.formatEther(redeemKash)} / ${ethers.formatEther(totalSupply)} total`);
      console.log(`  FRACTION     : ${pct}%  (use this for scripts 06 and 10)`);
    } catch {
      // No redeem requests or KASH token not set — mint-only batch
    }
  }
  console.log();
}

main().catch(e => { console.error(e); process.exit(1); });
