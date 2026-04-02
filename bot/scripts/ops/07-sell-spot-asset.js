/**
 * 07-sell-spot-asset — Sell spot ETH/wBTC in the perp DEX for USDC.
 *
 * Applies to: USDC-collateral perp DEXs (Hyperliquid).
 * After closing the short (step 06), the collateral is returned as spot ETH/wBTC.
 * This step converts it all back to USDC so it can be withdrawn and used to
 * repay the Aave borrow (step 09).
 *
 * For asset-collateral DEXs (Aster): skip this step. Instead, use
 * 12-withdraw-asset-from-perp to retrieve ETH/wBTC, then sell via 11-swap-usdc-for-asset
 * if a USDC conversion is needed to repay Aave.
 *
 * Auto: sells all spot ETH/wBTC in the perp DEX.
 * Override: AMOUNT=0.5  (ETH or wBTC units)
 *
 * Usage:
 *   PRODUCT=eth npx hardhat run bot/scripts/ops/07-sell-spot-asset.js --network arbitrumSepolia
 */
const { getContract, getState, displayState, parseAsset, fmtAsset, fmtUsdc, exec, PRODUCT, ASSET_SYMBOL } = require("./_utils");

async function main() {
  console.log(`\n07 — Sell spot ${ASSET_SYMBOL} on perp DEX → USDC  [product=${PRODUCT.toUpperCase()}]`);

  const contract = await getContract();
  const before   = await getState(contract);
  displayState(before, "Before");

  const amount = process.env.AMOUNT
    ? parseAsset(process.env.AMOUNT)
    : before.perpAsset;

  if (amount === 0n) {
    console.log(`\nNothing to sell — perp DEX ${ASSET_SYMBOL} balance is zero.`);
    return;
  }

  console.log(`\nSelling ${fmtAsset(amount)}...`);
  await exec(
    `spotSellOnHyperliquid(${fmtAsset(amount)})`,
    contract.spotSellOnHyperliquid(amount)
  );

  const after = await getState(contract);
  displayState(after, "After");
  const usdcGained = after.perpUsdc - before.perpUsdc;
  if (usdcGained > 0n) console.log(`  → USDC received: ${fmtUsdc(usdcGained)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
