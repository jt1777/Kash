/**
 * 11a-swap-asset-for-usdc — Swap ETH/wBTC in the contract → USDC via the spot DEX.
 *
 * Use case (rising price scenario): The HL short lost money, so after closing the short
 * and withdrawing USDC, there isn't enough USDC to repay the full Aave borrow.
 * This script sells some of the Aave-withdrawn ETH/wBTC on the spot DEX to plug the gap.
 *
 * AMOUNT=0.1  → swap an explicit amount in ETH/wBTC units
 * AUTO=true   → auto-computes: amount needed = aaveDebt - contractUsdc (in asset units)
 *
 * Usage:
 *   PRODUCT=eth AUTO=true    npx hardhat run bot/scripts/ops/11a-swap-asset-for-usdc.js --network arbitrumSepolia
 *   PRODUCT=eth AMOUNT=0.1   npx hardhat run bot/scripts/ops/11a-swap-asset-for-usdc.js --network arbitrumSepolia
 */
const { ethers } = require("hardhat");
const { getContract, getState, displayState, parseAsset, fmtAsset, fmtUsdc, exec, PRODUCT, IS_BTC, ASSET_SYMBOL, DECIMALS } = require("./_utils");

async function main() {
  console.log(`\n11a — Swap ${ASSET_SYMBOL} → USDC via spot DEX  [product=${PRODUCT.toUpperCase()}]`);

  const contract = await getContract();
  const spotDex  = await contract.spotDexAddress();
  if (!spotDex || spotDex === ethers.ZeroAddress) {
    console.error("  ❌  spotDexAddress not set on contract. Run setSpotDex.js first.");
    process.exit(1);
  }

  const before = await getState(contract);
  displayState(before, "Before");

  let amount;
  if (process.env.AMOUNT) {
    amount = parseAsset(process.env.AMOUNT);
  } else if (process.env.AUTO === "true") {
    // Calculate how much ETH/wBTC to sell to cover the remaining Aave debt gap
    if (before.aaveDebt <= before.contractUsdc) {
      console.log("\nNo gap — contract USDC already covers Aave debt. Nothing to swap.");
      return;
    }
    const usdcGap = before.aaveDebt - before.contractUsdc;
    const assetDecimalsFactor = BigInt(10) ** BigInt(DECIMALS);
    amount = (usdcGap * BigInt(1e12) * assetDecimalsFactor) / before.price;
    console.log(`\n  Aave debt        : ${fmtUsdc(before.aaveDebt)}`);
    console.log(`  Contract USDC    : ${fmtUsdc(before.contractUsdc)}`);
    console.log(`  Gap              : ${fmtUsdc(usdcGap)}`);
    console.log(`  Asset to sell    : ${fmtAsset(amount)} (at current price)`);
  } else {
    console.log(`\n  Spot DEX: ${spotDex}`);
    console.log(`\n  ⚠️  Set AMOUNT=<${ASSET_SYMBOL}> or AUTO=true to execute.`);
    return;
  }

  if (amount === 0n) { console.log("\nNothing to swap."); return; }

  await exec(`swapForUsdc(${fmtAsset(amount)})`, contract.swapForUsdc(amount));

  const after = await getState(contract);
  displayState(after, "After");
  const usdcGained = after.contractUsdc - before.contractUsdc;
  if (usdcGained > 0n) console.log(`  → USDC received: ${fmtUsdc(usdcGained)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
