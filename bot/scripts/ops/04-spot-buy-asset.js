/**
 * 04-spot-buy-asset — Buy spot ETH/wBTC on the perp DEX using USDC in the spot wallet.
 *
 * Applies to: USDC-collateral perp DEXs (Hyperliquid).
 * The purchased spot asset becomes the collateral for the short position (step 05).
 * Skip this step for asset-collateral DEXs (Aster) — use 03b instead.
 *
 * Auto: uses all USDC currently in the perp DEX spot wallet.
 * Override: AMOUNT=500  (USDC to spend)
 *
 * Usage:
 *   PRODUCT=eth npx hardhat run bot/scripts/ops/04-spot-buy-asset.js --network arbitrumSepolia
 */
const { getContract, getState, displayState, parseUsdc, fmtUsdc, fmtAsset, exec, PRODUCT, ASSET_SYMBOL } = require("./_utils");

async function main() {
  console.log(`\n04 — Spot buy ${ASSET_SYMBOL} on perp DEX  [product=${PRODUCT.toUpperCase()}]`);

  const contract = await getContract();
  const before   = await getState(contract);
  displayState(before, "Before");

  const amount = process.env.AMOUNT
    ? parseUsdc(process.env.AMOUNT)
    : before.perpUsdc;

  if (amount === 0n) {
    console.log("\nNothing to buy — perp DEX USDC spot balance is zero.");
    return;
  }

  await exec(
    `spotBuyOnHyperliquid(${fmtUsdc(amount)})`,
    contract.spotBuyOnHyperliquid(amount)
  );

  const after = await getState(contract);
  displayState(after, "After");
  const bought = after.perpAsset - before.perpAsset;
  if (bought > 0n) console.log(`  → Received: ${fmtAsset(bought)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
