/**
 * 03-deposit-usdc-to-perp — Deposit USDC from the contract to the perp DEX spot wallet.
 *
 * Applies to: USDC-collateral perp DEXs (Hyperliquid).
 * Not needed for asset-collateral DEXs (Aster) — use 03b-deposit-asset-to-perp instead.
 *
 * Auto: deposits all USDC currently in the contract.
 * Override: AMOUNT=1000  (USDC units)
 *
 * Usage:
 *   PRODUCT=eth npx hardhat run bot/scripts/ops/03-deposit-usdc-to-perp.js --network arbitrumSepolia
 */
const { getContract, getState, displayState, parseUsdc, fmtUsdc, exec, PRODUCT } = require("./_utils");

async function main() {
  console.log(`\n03 — Deposit USDC to perp DEX  [product=${PRODUCT.toUpperCase()}]`);

  const contract = await getContract();
  const before   = await getState(contract);
  displayState(before, "Before");

  const amount = process.env.AMOUNT
    ? parseUsdc(process.env.AMOUNT)
    : before.contractUsdc;

  if (amount === 0n) {
    console.log("\nNothing to deposit — contract USDC balance is zero.");
    return;
  }

  await exec(
    `depositToHyperliquid(${fmtUsdc(amount)})`,
    contract.depositToHyperliquid(amount)
  );

  displayState(await getState(contract), "After");
}

main().catch(e => { console.error(e); process.exit(1); });
