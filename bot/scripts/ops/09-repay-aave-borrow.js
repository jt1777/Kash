/**
 * 09-repay-aave-borrow — Repay the USDC borrow on Aave using USDC in the contract.
 *
 * Auto: repays as much as possible (min of contract USDC balance and outstanding debt).
 * Override: AMOUNT=1000  (USDC units)
 *
 * After repayment, the Aave health factor rises and the collateral becomes fully
 * withdrawable (step 10).
 *
 * Usage:
 *   PRODUCT=eth npx hardhat run bot/scripts/ops/09-repay-aave-borrow.js --network arbitrumOne
 *   PRODUCT=eth npx hardhat run bot/scripts/ops/09-repay-aave-borrow.js --network arbitrumSepolia
 */
const { ethers } = require("hardhat");
const { getContract, getState, displayState, parseUsdc, fmtUsdc, exec, PRODUCT } = require("./_utils");

async function main() {
  console.log(`\n09 — Repay Aave USDC borrow  [product=${PRODUCT.toUpperCase()}]`);

  const contract = await getContract();
  const usdcAddr = await contract.usdcAddress();
  const before   = await getState(contract);
  displayState(before, "Before");

  if (before.aaveDebt === 0n) {
    console.log("\nNo Aave borrow to repay.");
    return;
  }
  if (before.contractUsdc === 0n) {
    console.log("\nNo USDC in contract to repay with. Run steps 07 and 08 first.");
    return;
  }

  let amount;
  const MAX_UINT256 = ethers.MaxUint256;

  if (process.env.AMOUNT) {
    amount = parseUsdc(process.env.AMOUNT);
  } else if (before.contractUsdc >= before.aaveDebt) {
    // Contract has enough to cover the full debt — use MAX_UINT256 so Aave repays
    // the exact outstanding balance (including interest accrued between read and mine).
    amount = MAX_UINT256;
  } else {
    // Partial: contract USDC is less than the debt — repay what we have
    amount = before.contractUsdc;
  }

  const displayAmount = amount === MAX_UINT256 ? `${fmtUsdc(before.aaveDebt)} (full — using MAX)` : fmtUsdc(amount);
  console.log(`\n  Outstanding debt : ${fmtUsdc(before.aaveDebt)}`);
  console.log(`  Available USDC   : ${fmtUsdc(before.contractUsdc)}`);
  console.log(`  Repaying         : ${displayAmount}`);

  if (amount !== MAX_UINT256 && amount < before.aaveDebt) {
    const remaining = before.aaveDebt - amount;
    console.log(`\n  ⚠️  Partial repayment — ${fmtUsdc(remaining)} still owed after this step.`);
    console.log(`     If the USDC shortfall is due to a rising price scenario,`);
    console.log(`     use 10-withdraw-from-aave + 11a-swap-asset-for-usdc to cover the gap.`);
  }

  await exec(
    `repayToAave(USDC, ${displayAmount})`,
    contract.repayToAave(usdcAddr, amount)
  );

  displayState(await getState(contract), "After");
}

main().catch(e => { console.error(e); process.exit(1); });
