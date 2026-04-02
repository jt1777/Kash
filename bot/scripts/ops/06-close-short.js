/**
 * 06-close-short — Close a proportion of the short position on the active perp DEX.
 *
 * Closing returns the proportional USDC P&L and collateral (USDC or ETH/wBTC
 * depending on DEX type) to the perp DEX spot wallet.
 *
 * Required: FRACTION=50  (percentage to close, 1–100)
 *           FRACTION=100 closes the entire position.
 *
 * Usage:
 *   PRODUCT=eth FRACTION=100 npx hardhat run bot/scripts/ops/06-close-short.js --network arbitrumSepolia
 *   PRODUCT=eth FRACTION=50  npx hardhat run bot/scripts/ops/06-close-short.js --network arbitrumSepolia
 */
const { ethers } = require("hardhat");
const { getContract, getState, displayState, getRedeemFraction, fmtAsset, fmtUsdc, exec, PRODUCT, IS_BTC, ASSET_SYMBOL } = require("./_utils");

async function main() {
  console.log(`\n06 — Close short  [product=${PRODUCT.toUpperCase()}]`);

  const contract = await getContract();
  const before   = await getState(contract);
  displayState(before, "Before");

  if (!before.posActive || before.shortSize === 0n) {
    console.log("\nNo active short position to close.");
    return;
  }

  let fraction;
  if (process.env.FRACTION) {
    fraction = parseInt(process.env.FRACTION, 10);
    if (fraction < 1 || fraction > 100) throw new Error("FRACTION must be 1–100");
  } else {
    // Auto-derive from Phase 1 batch data
    const { pct, fraction18, redeemKash, totalSupply } = await getRedeemFraction(contract, before.batchCycle);
    console.log(`\n  Auto-computed from batch ${before.batchCycle}:`);
    console.log(`    Redeem KASH : ${ethers.formatEther(redeemKash)} / ${ethers.formatEther(totalSupply)} total supply`);
    console.log(`    Fraction    : ${pct}%`);
    fraction = Math.round(Number(fraction18) / 1e16);
    // Use 100 if rounding would leave a dust remainder
    if (fraction18 >= BigInt(99) * BigInt(1e16)) fraction = 100;
  }

  const symbol    = IS_BTC ? "BTC" : "ETH";
  const closeSize = (before.shortSize * BigInt(fraction)) / 100n;
  const isFull    = fraction === 100 || closeSize >= before.shortSize;

  console.log(`\n  Closing ${fraction}% of short (${fmtAsset(closeSize)} of ${fmtAsset(before.shortSize)})...`);

  if (isFull) {
    await exec(`closeShort("${symbol}") [full]`, contract["closeShort(string)"](symbol));
  } else {
    await exec(
      `closeShort("${symbol}", ${fmtAsset(closeSize)})`,
      contract["closeShort(string,uint256)"](symbol, closeSize)
    );
  }

  const after = await getState(contract);
  displayState(after, "After");
  const usdcGained = after.perpUsdc - before.perpUsdc;
  if (usdcGained > 0n) console.log(`  → USDC P&L received: ${fmtUsdc(usdcGained)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
