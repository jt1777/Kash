/**
 * 10-withdraw-from-aave — Withdraw the proportional ETH/wBTC collateral from Aave.
 *
 * Run this AFTER repaying the Aave borrow (step 09) so the health factor allows
 * a full proportional withdrawal.
 *
 * FRACTION=50   → withdraw 50% of the current Aave supplied balance
 * FRACTION=100  → withdraw everything (use for full redemption)
 * AMOUNT=1.5    → withdraw an explicit amount in ETH/wBTC units (overrides FRACTION)
 *
 * Usage:
 *   PRODUCT=eth FRACTION=100 npx hardhat run bot/scripts/ops/10-withdraw-from-aave.js --network arbitrumOne
 *   PRODUCT=eth FRACTION=50  npx hardhat run bot/scripts/ops/10-withdraw-from-aave.js --network arbitrumOne
 *   PRODUCT=eth AMOUNT=0.5   npx hardhat run bot/scripts/ops/10-withdraw-from-aave.js --network arbitrumOne
 *   PRODUCT=eth FRACTION=100 npx hardhat run bot/scripts/ops/10-withdraw-from-aave.js --network arbitrumSepolia
 */
const { ethers } = require("hardhat");
const { getContract, getState, displayState, getRedeemFraction, parseAsset, fmtAsset, exec, PRODUCT, ASSET_SYMBOL } = require("./_utils");

async function main() {
  console.log(`\n10 — Withdraw ${ASSET_SYMBOL} from Aave  [product=${PRODUCT.toUpperCase()}]`);

  const contract = await getContract();
  const before   = await getState(contract);
  displayState(before, "Before");

  if (before.aaveSupplied === 0n) {
    console.log("\nNothing in Aave to withdraw.");
    return;
  }

  let amount;
  if (process.env.AMOUNT) {
    amount = parseAsset(process.env.AMOUNT);
  } else {
    let fraction;
    if (process.env.FRACTION) {
      fraction = parseInt(process.env.FRACTION, 10);
      if (fraction < 1 || fraction > 100) throw new Error("FRACTION must be 1–100");
    } else {
      // Auto-derive from Phase 1 batch data
      const { pct, fraction18, redeemKash, totalSupply } = await getRedeemFraction(contract, before.batchCycle);
      console.log(`\n  Auto-computed from batch ${before.batchCycle}:`);
      console.log(`    Redeem KASH : ${ethers.formatEther(redeemKash)} / ${ethers.formatEther(totalSupply)} total supply`);
      console.log(`    Fraction    : ${pct}%`);
      fraction = Math.round(Number(fraction18) / 1e16);
      if (fraction18 >= BigInt(99) * BigInt(1e16)) fraction = 100;
    }
    amount = fraction === 100
      ? before.aaveSupplied   // full withdrawal sweeps entire position
      : (before.aaveSupplied * BigInt(fraction)) / 100n;
  }

  if (before.aaveDebt > 0n) {
    console.log(`\n  ⚠️  Aave still has ${require("./_utils").fmtUsdc(before.aaveDebt)} debt.`);
    console.log(`     Aave may revert if withdrawal would push health factor below 1.`);
    console.log(`     Run 09-repay-aave-borrow first (or continue if health factor allows it).`);
  }

  console.log(`\n  Withdrawing ${fmtAsset(amount)} from ${fmtAsset(before.aaveSupplied)} supplied...`);
  await exec(
    `withdrawFromAave(${fmtAsset(amount)})`,
    contract.withdrawFromAave(amount)
  );

  displayState(await getState(contract), "After");
}

main().catch(e => { console.error(e); process.exit(1); });
