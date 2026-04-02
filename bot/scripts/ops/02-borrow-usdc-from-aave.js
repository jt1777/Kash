/**
 * 02-borrow-usdc-from-aave — Borrow USDC from Aave against the deposited collateral.
 *
 * Auto: borrows up to BORROW_LTV_PCT % of the current collateral value (default 70%),
 *       minus any USDC already borrowed.
 * Override: AMOUNT=1500  (USDC units, e.g. 1500 = $1,500 USDC)
 *
 * Usage:
 *   PRODUCT=eth npx hardhat run bot/scripts/ops/02-borrow-usdc-from-aave.js --network arbitrumSepolia
 *   PRODUCT=eth AMOUNT=1000 npx hardhat run bot/scripts/ops/02-borrow-usdc-from-aave.js --network arbitrumSepolia
 */
const { ethers } = require("hardhat");
const { getContract, getState, displayState, parseUsdc, fmtUsdc, exec, IS_BTC, PRODUCT, DECIMALS } = require("./_utils");

async function main() {
  console.log(`\n02 — Borrow USDC from Aave  [product=${PRODUCT.toUpperCase()}]`);

  const contract = await getContract();
  const usdcAddr = await contract.usdcAddress();
  const before   = await getState(contract);
  displayState(before, "Before");

  let amount;
  if (process.env.AMOUNT) {
    amount = parseUsdc(process.env.AMOUNT);
  } else {
    // Auto: target borrow = LTV% × collateral USD value, minus existing debt
    const ltvPct = BigInt(process.env.BORROW_LTV_PCT || "70");
    const assetDecimalsFactor = BigInt(10) ** BigInt(DECIMALS);
    const collateralUsd18 = (before.aaveSupplied * before.price) / assetDecimalsFactor;
    const targetBorrowUsd18 = (collateralUsd18 * ltvPct) / 100n;
    const targetUsdc = targetBorrowUsd18 / BigInt(1e12);
    const newBorrow  = targetUsdc > before.aaveDebt ? targetUsdc - before.aaveDebt : 0n;
    amount = newBorrow;
    console.log(`\n  Collateral value: $${ethers.formatEther(collateralUsd18)}`);
    console.log(`  Target borrow (${ltvPct}% LTV): ${fmtUsdc(targetUsdc)}`);
    console.log(`  Already borrowed: ${fmtUsdc(before.aaveDebt)}`);
    console.log(`  → Borrowing delta: ${fmtUsdc(amount)}`);
  }

  if (amount === 0n) {
    console.log("\nNothing to borrow — already at or above target LTV.");
    return;
  }

  await exec(
    `borrowFromAave(USDC, ${fmtUsdc(amount)})`,
    contract.borrowFromAave(usdcAddr, amount)
  );

  displayState(await getState(contract), "After");
}

main().catch(e => { console.error(e); process.exit(1); });
