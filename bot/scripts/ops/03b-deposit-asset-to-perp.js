/**
 * 03b-deposit-asset-to-perp — Deposit ETH/wBTC from the contract to the perp DEX as collateral.
 *
 * Applies to: asset-collateral perp DEXs (Aster and similar).
 * For these DEXs, the short position is collateralised directly with ETH or wBTC —
 * no USDC deposit or spot buy is needed before opening the short.
 *
 * Auto: deposits all asset (ETH/wBTC) currently in the contract.
 * Override: AMOUNT=0.5  (ETH or wBTC units)
 *
 * Usage:
 *   PRODUCT=eth npx hardhat run bot/scripts/ops/03b-deposit-asset-to-perp.js --network arbitrumSepolia
 */
const {
  getContract, getExchangeTarget, getState, displayState,
  parseAsset, fmtAsset, exec, PRODUCT, ASSET_SYMBOL,
} = require("./_utils");

async function main() {
  console.log(`\n03b — Deposit ${ASSET_SYMBOL} to perp DEX (asset-collateral path)  [product=${PRODUCT.toUpperCase()}]`);

  const contract = await getContract();
  const before   = await getState(contract);
  displayState(before, "Before");

  const amount = process.env.AMOUNT
    ? parseAsset(process.env.AMOUNT)
    : before.contractAsset;

  if (amount === 0n) {
    console.log(`\nNothing to deposit — contract ${ASSET_SYMBOL} balance is zero.`);
    return;
  }

  // addCollateralToHyperliquid handles asset-collateral deposits on the active adapter
  const { target: ex } = await getExchangeTarget(contract);
  await exec(`addCollateralToHyperliquid(${fmtAsset(amount)})`, ex.addCollateralToHyperliquid(amount));

  displayState(await getState(contract), "After");
}

main().catch(e => { console.error(e); process.exit(1); });
