/**
 * 05-open-short — Open (or add to) a leveraged short on the active perp DEX.
 *
 * Applies to: both USDC-collateral DEXs (HL) and asset-collateral DEXs (Aster).
 *
 * Required: SIZE=1.7  (notional size in ETH or BTC units, 18 dec)
 *           - For HL: collateral is the spot asset balance already in the DEX
 *           - For Aster: collateral is the asset deposited in step 03b
 *
 * Auto suggestion: SHORT_LEVERAGE × (Aave collateral value / price) printed but not executed
 *                  without an explicit SIZE.
 *
 * Usage:
 *   PRODUCT=eth SIZE=1.7 npx hardhat run bot/scripts/ops/05-open-short.js --network arbitrumSepolia
 */
const { ethers } = require("hardhat");
const { getContract, getState, displayState, fmtAsset, exec, PRODUCT, IS_BTC, ASSET_SYMBOL, DECIMALS } = require("./_utils");

async function main() {
  console.log(`\n05 — Open short on perp DEX  [product=${PRODUCT.toUpperCase()}]`);

  const contract = await getContract();
  const before   = await getState(contract);
  displayState(before, "Before");

  // Suggest a size based on leverage
  const leverage = parseFloat(process.env.SHORT_LEVERAGE || "1.7");
  const assetDecimalsFactor = BigInt(10) ** BigInt(DECIMALS);
  const suggestedSize = before.aaveSupplied > 0n
    ? (before.aaveSupplied * BigInt(Math.round(leverage * 100))) / 100n
    : 0n;

  if (suggestedSize > 0n) {
    console.log(`\n  Suggested size at ${leverage}× leverage: ${fmtAsset(suggestedSize)}`);
  }

  if (!process.env.SIZE) {
    console.log("\n  ⚠️  Set SIZE=<amount> (in ETH or BTC units) to execute.");
    console.log(`  Example: SIZE=${ethers.formatUnits(suggestedSize, DECIMALS)} ...`);
    return;
  }

  const size = ethers.parseUnits(process.env.SIZE, 18); // short size always 18-dec
  const symbol = IS_BTC ? "BTC" : "ETH";

  if (before.posActive) {
    console.log(`\n  Existing short: ${fmtAsset(before.shortSize)} ${ASSET_SYMBOL}`);
    console.log(`  Adding ${fmtAsset(size)} to existing position...`);
  } else {
    console.log(`\n  Opening new ${symbol} short: ${fmtAsset(size)}...`);
  }

  await exec(
    `openShort("${symbol}", ${fmtAsset(size)})`,
    contract.openShort(symbol, size)
  );

  displayState(await getState(contract), "After");
}

main().catch(e => { console.error(e); process.exit(1); });
