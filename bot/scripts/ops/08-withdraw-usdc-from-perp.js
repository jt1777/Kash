/**
 * 08-withdraw-usdc-from-perp — Withdraw USDC from the perp DEX back to the contract.
 *
 * Applies to: USDC-collateral perp DEXs (Hyperliquid).
 * On real Hyperliquid, only USDC can be withdrawn — not ETH or wBTC.
 * For asset-collateral DEXs (Aster), use 12-withdraw-asset-from-perp instead.
 *
 * Auto: withdraws all USDC in the perp DEX spot wallet.
 * Override: AMOUNT=1000  (USDC units)
 *
 * Usage:
 *   PRODUCT=eth npx hardhat run bot/scripts/ops/08-withdraw-usdc-from-perp.js --network arbitrumSepolia
 */
const { getContract, getState, displayState, parseUsdc, fmtUsdc, exec, PRODUCT } = require("./_utils");

async function main() {
  console.log(`\n08 — Withdraw USDC from perp DEX  [product=${PRODUCT.toUpperCase()}]`);

  const contract = await getContract();
  const before   = await getState(contract);
  displayState(before, "Before");

  const amount = process.env.AMOUNT
    ? parseUsdc(process.env.AMOUNT)
    : before.perpUsdc;

  if (amount === 0n) {
    console.log("\nNothing to withdraw — perp DEX USDC balance is zero.");
    return;
  }

  await exec(
    `withdrawFromHyperliquid(${fmtUsdc(amount)})`,
    contract.withdrawFromHyperliquid(amount)
  );

  displayState(await getState(contract), "After");
}

main().catch(e => { console.error(e); process.exit(1); });
