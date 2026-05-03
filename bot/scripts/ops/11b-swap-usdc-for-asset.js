/**
 * 11b-swap-usdc-for-asset — Swap USDC in the contract → ETH/wBTC via the spot DEX.
 *
 * Use case (falling price scenario): After repaying the Aave borrow and withdrawing
 * the ETH/wBTC collateral, the contract doesn't have enough ETH/wBTC to pay all
 * redeemers (because redeemers are owed MORE ETH at the lower price).
 * The excess USDC from the HL short P&L is swapped here to make up the shortfall.
 *
 * AMOUNT=500  → swap an explicit USDC amount
 * AUTO=true   → auto-computes shortfall from Phase 2 requirements vs contract balance
 *               (requires BATCH_CYCLE and LOCKED_NAV env vars)
 *
 * Usage:
 *   PRODUCT=eth AMOUNT=500                    npx hardhat run bot/scripts/ops/11b-swap-usdc-for-asset.js --network arbitrumSepolia
 *   PRODUCT=eth AUTO=true BATCH_CYCLE=493089  npx hardhat run bot/scripts/ops/11b-swap-usdc-for-asset.js --network arbitrumSepolia
 */
const { ethers } = require("hardhat");
const {
  getContract, getState, displayState,
  parseUsdc, fmtUsdc, fmtAsset, exec,
  PRODUCT, IS_BTC, ASSET_SYMBOL, DECIMALS,
} = require("./_utils");

async function main() {
  console.log(`\n11b — Swap USDC → ${ASSET_SYMBOL} via spot DEX  [product=${PRODUCT.toUpperCase()}]`);

  const contract = await getContract();
  const spotDex  = await contract.spotDexAddress();
  if (!spotDex || spotDex === ethers.ZeroAddress) {
    console.error("  ❌  spotDexAddress not set on contract. Run setSpotDex.js first.");
    process.exit(1);
  }

  const before = await getState(contract);
  displayState(before, "Before");

  let usdcToSwap;
  if (process.env.AMOUNT) {
    usdcToSwap = parseUsdc(process.env.AMOUNT);
  } else if (process.env.AUTO === "true") {
    // Estimate required ETH/wBTC from Phase 2 batch data
    const batchCycle = process.env.BATCH_CYCLE
      ? BigInt(process.env.BATCH_CYCLE)
      : before.batchCycle;

    const BATCH_ABI = [
      "function getBatchInfo(uint256) view returns (uint256,uint256,bool,uint256,uint256,uint256)",
      "function batchRedeemUsers(uint256,uint256) view returns (address)",
      "function getPendingRedeemRequest(address, uint256) view returns (tuple(address user, uint256 kashAmount, uint256 batchCycle))",
      "function currentNAV() view returns (uint256)",
      "function feeBps() view returns (uint256)",
    ];
    const batchContract = new ethers.Contract(
      await contract.getAddress(), BATCH_ABI, ethers.provider
    );
    const info = await batchContract.getBatchInfo(batchCycle);
    const redeemUsersCount = Number(info[4]);
    const nav = BigInt((await batchContract.currentNAV()).toString());
    const feeBps = BigInt((await batchContract.feeBps()).toString());
    const assetDecimalsFactor = BigInt(10) ** BigInt(DECIMALS);

    let totalRedeemAsset = 0n;
    for (let i = 0; i < redeemUsersCount; i++) {
      const addr = await batchContract.batchRedeemUsers(batchCycle, i);
      const req = await batchContract.getPendingRedeemRequest(addr, batchCycle);
      const kashAmt = BigInt(req.kashAmount.toString());
      if (kashAmt === 0n) continue;
      const usdAfterFee = (kashAmt * nav / BigInt(1e18)) * (10000n - feeBps) / 10000n;
      totalRedeemAsset += (usdAfterFee * assetDecimalsFactor) / before.price;
    }

    const shortfall = totalRedeemAsset > before.contractAsset
      ? totalRedeemAsset - before.contractAsset
      : 0n;

    if (shortfall === 0n) {
      console.log(`\nNo shortfall — contract has enough ${ASSET_SYMBOL} for all redeemers.`);
      return;
    }

    const usdcNeeded = (shortfall * before.price) / (BigInt(10) ** BigInt(DECIMALS)) / BigInt(1e12);
    console.log(`\n  Redeemers need   : ${fmtAsset(totalRedeemAsset)}`);
    console.log(`  Contract has     : ${fmtAsset(before.contractAsset)}`);
    console.log(`  Shortfall        : ${fmtAsset(shortfall)}`);
    console.log(`  USDC to swap     : ${fmtUsdc(usdcNeeded)}`);

    usdcToSwap = usdcNeeded < before.contractUsdc ? usdcNeeded : before.contractUsdc;
    if (usdcToSwap < usdcNeeded) {
      console.log(`  ⚠️  Only ${fmtUsdc(before.contractUsdc)} USDC available — partial swap.`);
    }
  } else {
    console.log(`\n  Spot DEX: ${spotDex}`);
    console.log(`\n  ⚠️  Set AMOUNT=<USDC> or AUTO=true (with BATCH_CYCLE=N) to execute.`);
    return;
  }

  if (usdcToSwap === 0n) { console.log("\nNothing to swap."); return; }

  await exec(`swapFromUsdc(${fmtUsdc(usdcToSwap)})`, contract.swapFromUsdc(usdcToSwap));

  const after = await getState(contract);
  displayState(after, "After");
  const assetGained = after.contractAsset - before.contractAsset;
  if (assetGained > 0n) console.log(`  → ${ASSET_SYMBOL} received: ${fmtAsset(assetGained)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
