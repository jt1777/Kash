/**
 * 12-withdraw-asset-from-perp — Withdraw ETH/wBTC from the perp DEX back to the contract.
 *
 * Applies to: asset-collateral perp DEXs (Aster and similar).
 * On these DEXs, closing the short returns ETH/wBTC collateral to the DEX's internal
 * balance. This script withdraws that ETH/wBTC to the contract so it can be used to
 * pay redeemers in Phase 2.
 *
 * NOT needed for Hyperliquid (USDC-only withdrawal). On HL, use 08-withdraw-usdc-from-perp
 * and then 11b-swap-usdc-for-asset if additional ETH/wBTC is needed.
 *
 * Auto: withdraws full asset balance from the perp DEX.
 * Override: AMOUNT=0.5  (ETH or wBTC units)
 *
 * Usage:
 *   PRODUCT=eth npx hardhat run bot/scripts/ops/12-withdraw-asset-from-perp.js --network arbitrumSepolia
 *   PRODUCT=btc npx hardhat run bot/scripts/ops/12-withdraw-asset-from-perp.js --network arbitrumSepolia
 */
const { getContract, getState, displayState, parseAsset, fmtAsset, exec, PRODUCT, IS_BTC, ASSET_SYMBOL } = require("./_utils");

async function main() {
  console.log(`\n12 — Withdraw ${ASSET_SYMBOL} from perp DEX (asset-collateral path)  [product=${PRODUCT.toUpperCase()}]`);

  const contract = await getContract();
  const before   = await getState(contract);
  displayState(before, "Before");

  const amount = process.env.AMOUNT
    ? parseAsset(process.env.AMOUNT)
    : before.perpAsset;

  if (amount === 0n) {
    console.log(`\nNothing to withdraw — perp DEX ${ASSET_SYMBOL} balance is zero.`);
    return;
  }

  const fn = IS_BTC ? "withdrawBtcFromHyperliquid" : "withdrawEthFromHyperliquid";
  await exec(
    `${fn}(${fmtAsset(amount)})`,
    IS_BTC
      ? contract.withdrawBtcFromHyperliquid(amount)
      : contract.withdrawEthFromHyperliquid(amount)
  );

  displayState(await getState(contract), "After");
}

main().catch(e => { console.error(e); process.exit(1); });
