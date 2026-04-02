/**
 * 01-deposit-to-aave — Deposit ETH (or wBTC) from the contract into Aave as collateral.
 *
 * Auto: deposits the full asset balance currently sitting in the contract.
 * Override: AMOUNT=1.5  (in ETH or wBTC units)
 *
 * Usage:
 *   PRODUCT=eth npx hardhat run bot/scripts/ops/01-deposit-to-aave.js --network arbitrumSepolia
 *   PRODUCT=eth AMOUNT=0.5 npx hardhat run bot/scripts/ops/01-deposit-to-aave.js --network arbitrumSepolia
 */
const { ethers } = require("hardhat");
const { getContract, getState, displayState, parseAsset, fmtAsset, exec, IS_BTC, PRODUCT } = require("./_utils");

async function main() {
  console.log(`\n01 — Deposit ${IS_BTC ? "wBTC" : "ETH"} to Aave  [product=${PRODUCT.toUpperCase()}]`);

  const contract = await getContract();
  const before   = await getState(contract);
  displayState(before, "Before");

  // Amount: env override or full contract asset balance
  const amount = process.env.AMOUNT
    ? parseAsset(process.env.AMOUNT)
    : before.contractAsset;

  if (amount === 0n) {
    console.log("\nNothing to deposit — contract asset balance is zero.");
    return;
  }

  console.log(`\nDepositing ${fmtAsset(amount)} to Aave...`);
  await exec(
    `depositToAave(${fmtAsset(amount)})`,
    contract.depositToAave(amount)
  );

  displayState(await getState(contract), "After");
}

main().catch(e => { console.error(e); process.exit(1); });
