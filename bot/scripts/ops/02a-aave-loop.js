/**
 * 02a-aave-loop — Round 2 of the Aave leverage loop (after 01 + 02).
 *
 * Prerequisite: contract already has USDC from 02-borrow-usdc-from-aave.js.
 *
 * Steps (single script, three txs):
 *   1. swapFromUsdc — all ops-visible USDC → ETH/wBTC via spot DEX
 *   2. depositToAave — all ops-visible asset from the swap
 *   3. borrowFromAave — incremental USDC to reach BORROW_LTV_PCT on total collateral
 *
 * Example ($100 asset deposited in 01, 70% LTV):
 *   After 02:  $100 in Aave, $70 USDC borrowed, $70 USDC on vault
 *   After 02a: $170 in Aave, $119 USDC borrowed, $119 USDC on vault
 *
 * Usage:
 *   PRODUCT=btc npx hardhat run bot/scripts/ops/02a-aave-loop.js --network arbitrumOne
 */
const { ethers } = require("hardhat");
const {
  getContract,
  getState,
  displayState,
  fmtUsdc,
  fmtAsset,
  exec,
  resolveSwapMinOut,
  PRODUCT,
  DECIMALS,
} = require("./_utils");

async function borrowLtvDelta(contract, state) {
  const usdcAddr = await contract.usdcAddress();
  const ltvPct = BigInt(process.env.BORROW_LTV_PCT || "70");
  const assetDecimalsFactor = BigInt(10) ** BigInt(DECIMALS);
  const collateralUsd18 = (state.aaveSupplied * state.price) / assetDecimalsFactor;
  const targetBorrowUsd18 = (collateralUsd18 * ltvPct) / 100n;
  const targetUsdc = targetBorrowUsd18 / BigInt(1e12);
  const amount = targetUsdc > state.aaveDebt ? targetUsdc - state.aaveDebt : 0n;
  return { usdcAddr, amount, targetUsdc, ltvPct };
}

async function main() {
  console.log(`\n02a — Aave leverage loop (round 2)  [product=${PRODUCT.toUpperCase()}]`);

  const contract = await getContract();
  let state = await getState(contract);
  displayState(state, "Before");

  const spotDex = await contract.spotDexAddress();
  if (!spotDex || spotDex === ethers.ZeroAddress) {
    console.error("  ❌  spotDexAddress not set on contract. Run setSpotDex.js first.");
    process.exit(1);
  }

  if (state.contractUsdc === 0n) {
    console.log("\nNothing to loop — ops-visible USDC balance is zero.");
    console.log("Run 02-borrow-usdc-from-aave.js first (or check ownerUsdcReserve).");
    return;
  }

  // Step 1 — swap all USDC → asset
  console.log(`\nStep 1/3 — swap ${fmtUsdc(state.contractUsdc)} → asset`);
  const minOut = await resolveSwapMinOut(contract, "usdcToAsset", state.contractUsdc);
  await exec(
    `swapFromUsdc(${fmtUsdc(state.contractUsdc)}, minOut=${fmtAsset(minOut)})`,
    contract.swapFromUsdc(state.contractUsdc, minOut),
  );
  state = await getState(contract);

  if (state.contractAsset === 0n) {
    console.log("\nSwap produced no ops-visible asset — stopping.");
    displayState(state, "After swap");
    return;
  }

  // Step 2 — deposit all asset to Aave
  console.log(`\nStep 2/3 — deposit ${fmtAsset(state.contractAsset)} to Aave`);
  await exec(
    `depositToAave(${fmtAsset(state.contractAsset)})`,
    contract.depositToAave(state.contractAsset),
  );
  state = await getState(contract);

  // Step 3 — borrow LTV delta
  const { usdcAddr, amount, targetUsdc, ltvPct } = await borrowLtvDelta(contract, state);
  console.log(`\nStep 3/3 — borrow to ${ltvPct}% LTV`);
  console.log(
    `  Collateral value: $${ethers.formatEther((state.aaveSupplied * state.price) / (BigInt(10) ** BigInt(DECIMALS)))}`,
  );
  console.log(`  Target borrow: ${fmtUsdc(targetUsdc)}`);
  console.log(`  Already borrowed: ${fmtUsdc(state.aaveDebt)}`);
  console.log(`  → Borrowing delta: ${fmtUsdc(amount)}`);

  if (amount === 0n) {
    console.log("\nNothing to borrow — already at or above target LTV.");
  } else {
    await exec(
      `borrowFromAave(USDC, ${fmtUsdc(amount)})`,
      contract.borrowFromAave(usdcAddr, amount),
    );
  }

  displayState(await getState(contract), "After");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
