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
 *   PRODUCT=eth npx hardhat run bot/scripts/ops/09-repay-aave-borrow.js --network arbitrumSepolia
 */
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
  if (process.env.AMOUNT) {
    amount = parseUsdc(process.env.AMOUNT);
  } else {
    // Repay up to the outstanding debt (don't overpay)
    amount = before.contractUsdc < before.aaveDebt ? before.contractUsdc : before.aaveDebt;
  }

  console.log(`\n  Outstanding debt : ${fmtUsdc(before.aaveDebt)}`);
  console.log(`  Available USDC   : ${fmtUsdc(before.contractUsdc)}`);
  console.log(`  Repaying         : ${fmtUsdc(amount)}`);

  if (amount < before.aaveDebt) {
    const remaining = before.aaveDebt - amount;
    console.log(`\n  ⚠️  Partial repayment — ${fmtUsdc(remaining)} still owed after this step.`);
    console.log(`     If the USDC shortfall is due to a rising ${before.posActive ? "price" : "price"} scenario,`);
    console.log(`     use 10-withdraw-from-aave + 11a-swap-asset-for-usdc to cover the gap.`);
  }

  await exec(
    `repayToAave(USDC, ${fmtUsdc(amount)})`,
    contract.repayToAave(usdcAddr, amount)
  );

  displayState(await getState(contract), "After");
}

main().catch(e => { console.error(e); process.exit(1); });
