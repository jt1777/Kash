/**
 * 10-withdraw-from-aave — Withdraw the proportional ETH/wBTC collateral from Aave.
 *
 * Run this AFTER repaying the Aave borrow (step 09) so the health factor allows
 * a full proportional withdrawal.
 *
 * FRACTION=50   → withdraw 50% of the current Aave supplied balance
 * FRACTION=100  → withdraw entire position (uses Aave max-uint amount by default — avoids rounding reverts)
 * AMOUNT=1.5    → withdraw an explicit amount in ETH/wBTC units (overrides FRACTION)
 *
 * Env:
 *   WITHDRAW_EXACT=true — when set with FRACTION=100 (or auto 100%), use exact `aaveSupplied` from the
 *     snapshot instead of max uint256 (old behavior; can revert on Aave rounding edge cases).
 *
 * Usage:
 *   PRODUCT=eth FRACTION=100 npx hardhat run bot/scripts/ops/10-withdraw-from-aave.js --network arbitrumOne
 *   PRODUCT=eth FRACTION=50  npx hardhat run bot/scripts/ops/10-withdraw-from-aave.js --network arbitrumOne
 *   PRODUCT=eth AMOUNT=0.5   npx hardhat run bot/scripts/ops/10-withdraw-from-aave.js --network arbitrumOne
 *   PRODUCT=eth FRACTION=100 npx hardhat run bot/scripts/ops/10-withdraw-from-aave.js --network arbitrumSepolia
 */
const { ethers } = require("hardhat");
const {
  getContract,
  getState,
  displayState,
  getRedeemFraction,
  parseAsset,
  fmtAsset,
  exec,
  fmtUsdc,
  PRODUCT,
  ASSET_SYMBOL,
  assertKashYieldOpsSigner,
} = require("./_utils");

async function main() {
  console.log(`\n10 — Withdraw ${ASSET_SYMBOL} from Aave  [product=${PRODUCT.toUpperCase()}]`);

  const contract = await getContract();
  const [signer] = await ethers.getSigners();
  await assertKashYieldOpsSigner(contract, signer.address);

  const before = await getState(contract);
  displayState(before, "Before");

  if (before.aaveSupplied === 0n) {
    console.log("\nNothing in Aave to withdraw.");
    return;
  }

  let amount;
  let fullWithdrawMaxUint = false;

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

    if (fraction === 100 && (process.env.WITHDRAW_EXACT || "").toLowerCase() !== "true") {
      fullWithdrawMaxUint = true;
      amount = ethers.MaxUint256;
    } else if (fraction === 100) {
      amount = before.aaveSupplied;
    } else {
      amount = (before.aaveSupplied * BigInt(fraction)) / 100n;
    }
  }

  if (before.aaveDebt > 0n) {
    console.log(`\n  ⚠️  Aave still has ${fmtUsdc(before.aaveDebt)} debt.`);
    console.log(`     Aave may revert if withdrawal would push health factor below 1.`);
    console.log(`     Run 09-repay-aave-borrow first (or continue if health factor allows it).`);
  }

  if (fullWithdrawMaxUint) {
    console.log(
      `\n  Withdrawing full Aave ${ASSET_SYMBOL} position (amount = type(uint256).max → pool withdraws all).`,
    );
    console.log(`     Supplied (snapshot): ${fmtAsset(before.aaveSupplied)}`);
  } else {
    console.log(`\n  Withdrawing ${fmtAsset(amount)} from ${fmtAsset(before.aaveSupplied)} supplied...`);
  }

  const opLabel = fullWithdrawMaxUint
    ? "withdrawFromAave(maxUint256 — full position)"
    : `withdrawFromAave(${fmtAsset(amount)})`;

  await exec(opLabel, contract.withdrawFromAave(amount));

  displayState(await getState(contract), "After");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
