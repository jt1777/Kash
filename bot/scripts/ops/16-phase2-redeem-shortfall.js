/**
 * 16-phase2-redeem-shortfall — Read-only: wBTC/ETH required for Phase 2 vs on-vault balance.
 *
 * Matches _processBatchPhase2 checks:
 *   balance >= ownerReserve + mintProtocolFees + G (locked in batchTotalRedeemValueUSD at mark-done)
 *
 * When batchPhase >= 2, batchTotalRedeemValueUSD holds gross asset G (8/18 dec), not Phase-1 USD.
 * Otherwise falls back to MTM currentNAV per-redeemer estimate:
 *   - Prefer exact sum via batchRedeemUsers + getPendingRedeemRequest when the array is small
 *     enough to fit in an eth_call (override with PHASE2_SHORTFALL_MAX_REDEEMERS).
 *   - Otherwise use the linear aggregate from batchTotalRedeemKash (same formula as the
 *     contract loop); integer rounding can differ from the exact sum by a few wei—add a
 *     small buffer if you are borderline.
 *
 * Usage (repo root):
 *   PRODUCT=btc BATCH_CYCLE=493689 npx hardhat run bot/scripts/ops/16-phase2-redeem-shortfall.js --network arbitrumOne
 *   BATCH_CYCLE unset → uses getCurrentBatchCycle()
 */
const { ethers } = require("hardhat");
const {
  getContract,
  PRODUCT,
  IS_BTC,
  ASSET_SYMBOL,
  DECIMALS,
  fmtAsset,
  ERC20_ABI,
} = require("./_utils");

const VIEW_ABI = [
  "function getCurrentBatchCycle() view returns (uint256)",
  "function getBatchInfo(uint256) view returns (uint256,uint256,bool,uint256,uint256,uint256)",
  "function batchPhase(uint256) view returns (uint8)",
  "function batchTotalRedeemKash(uint256) view returns (uint256)",
  "function batchTotalRedeemValueUSD(uint256) view returns (uint256)",
  "function batchMintUsers(uint256,uint256) view returns (address)",
  "function getPendingMintRequest(address,uint256) view returns (tuple(address user,uint256 amountIn,uint256 amountInUSD,uint256 batchCycle))",
  "function currentNAV() view returns (uint256)",
  "function feeBps() view returns (uint256)",
  "function getBtcPrice() view returns (uint256)",
  "function getEthPrice() view returns (uint256)",
  "function ownerWbtcReserve() view returns (uint256)",
  "function ownerEthReserve() view returns (uint256)",
  "function wbtcAddress() view returns (address)",
  "function getPendingRedeemRequest(address,uint256) view returns (tuple(address user,uint256 kashAmount,uint256 batchCycle))",
  "function batchRedeemUsers(uint256,uint256) view returns (address)",
];

const NAV_DENOM = BigInt(1e18);

function aggregateNeeded(totalKash, nav, feeBps, price, assetDecimals) {
  if (totalKash === 0n) return 0n;
  const usdValue = (totalKash * nav) / NAV_DENOM;
  const usdAfterFee = (usdValue * (10000n - feeBps)) / 10000n;
  const factor = BigInt(10) ** BigInt(assetDecimals);
  return (usdAfterFee * factor) / price;
}

async function exactNeededFromList(v, batchCycle, redeemerCount, nav, feeBps, price, assetDecimals) {
  let total = 0n;
  const factor = BigInt(10) ** BigInt(assetDecimals);
  for (let i = 0; i < redeemerCount; i++) {
    const addr = await v.batchRedeemUsers(batchCycle, i);
    const req = await v.getPendingRedeemRequest(addr, batchCycle);
    const kashAmt = BigInt(req.kashAmount.toString());
    if (kashAmt === 0n) continue;
    const usdValue = (kashAmt * nav) / NAV_DENOM;
    const usdAfterFee = (usdValue * (10000n - feeBps)) / 10000n;
    total += (usdAfterFee * factor) / price;
  }
  return { total, redeemerCount };
}

async function computeMintFeeAsset(v, batchCycle) {
  const info = await v.getBatchInfo(batchCycle);
  const mintUsersCount = Number(info[3]);
  const feeBps = BigInt((await v.feeBps()).toString());
  let total = 0n;
  for (let i = 0; i < mintUsersCount; i++) {
    const addr = await v.batchMintUsers(batchCycle, i);
    const req = await v.getPendingMintRequest(addr, batchCycle);
    const amountIn = BigInt(req.amountIn.toString());
    if (amountIn === 0n) continue;
    total += (amountIn * feeBps) / 10000n;
  }
  return total;
}

async function main() {
  console.log(`\n16 — Phase 2 redeem ${ASSET_SYMBOL} shortfall (read-only)  [product=${PRODUCT.toUpperCase()}]`);

  const signerContract = await getContract();
  const vault = await signerContract.getAddress();
  const v = new ethers.Contract(vault, VIEW_ABI, ethers.provider);

  const batchCycle = process.env.BATCH_CYCLE
    ? BigInt(process.env.BATCH_CYCLE)
    : BigInt((await v.getCurrentBatchCycle()).toString());

  const maxIter = Number(process.env.PHASE2_SHORTFALL_MAX_REDEEMERS || "400");

  const info = await v.getBatchInfo(batchCycle);
  const processed = info[2];
  const redeemUsersCount = Number(info[4]);
  const totalRedeemKashOnChain = BigInt(info[5].toString());

  const phase = Number(await v.batchPhase(batchCycle));
  const nav = BigInt((await v.currentNAV()).toString());
  const feeBps = BigInt((await v.feeBps()).toString());
  const price = BigInt(
    (await (IS_BTC ? v.getBtcPrice() : v.getEthPrice())).toString(),
  );

  let ownerReserve = 0n;
  try {
    ownerReserve = BigInt(
      (await (IS_BTC ? v.ownerWbtcReserve() : v.ownerEthReserve())).toString(),
    );
  } catch {
    ownerReserve = 0n;
  }

  let have = 0n;
  if (IS_BTC) {
    const wbtcAddr = await v.wbtcAddress();
    const wbtc = new ethers.Contract(wbtcAddr, ERC20_ABI, ethers.provider);
    have = BigInt((await wbtc.balanceOf(vault)).toString());
  } else {
    have = BigInt((await ethers.provider.getBalance(vault)).toString());
  }

  const batchKash = BigInt((await v.batchTotalRedeemKash(batchCycle)).toString());
  const grossLockedG =
    phase >= 2
      ? BigInt((await v.batchTotalRedeemValueUSD(batchCycle)).toString())
      : 0n;

  console.log("\n  ── Batch ─────────────────────────────────────────────────");
  console.log(`  Vault:              ${vault}`);
  console.log(`  batchCycle:         ${batchCycle}`);
  console.log(`  batchPhase:         ${phase}  (need 2 for processBatchPhase2ForCycle)`);
  console.log(`  batchProcessed:     ${processed}`);
  console.log(`  redeemUsersCount:   ${redeemUsersCount}`);
  console.log(`  batchTotalRedeemKash (mapping): ${ethers.formatUnits(batchKash, 18)} KASH`);
  console.log(`  getBatchInfo[5] totalRedeemKash: ${ethers.formatUnits(totalRedeemKashOnChain, 18)} KASH`);
  console.log(`  locked G (batchTotalRedeemValueUSD when phase>=2): ${fmtAsset(grossLockedG)}`);

  if (batchKash !== totalRedeemKashOnChain) {
    console.log(
      "\n  ⚠️  batchTotalRedeemKash != getBatchInfo totalRedeemKash; using batchTotalRedeemKash for aggregate.",
    );
  }

  console.log("\n  ── Pricing (same block context as your RPC) ──────────────");
  console.log(`  currentNAV: ${ethers.formatEther(nav)} (18-dec)`);
  console.log(`  feeBps:     ${feeBps}`);
  console.log(
    `  ${IS_BTC ? "BTC" : "ETH"} price: ${ethers.formatEther(price)} USD (18-dec)`,
  );

  let totalRedeemAssetNeeded;
  let mintFeeAsset = 0n;
  let method;

  if (grossLockedG > 0n) {
    totalRedeemAssetNeeded = grossLockedG;
    mintFeeAsset = await computeMintFeeAsset(v, batchCycle);
    method = "locked G (batchTotalRedeemValueUSD after mark-done)";
  } else if (redeemUsersCount <= maxIter) {
    try {
      const { total } = await exactNeededFromList(v, batchCycle, redeemUsersCount, nav, feeBps, price, DECIMALS);
      totalRedeemAssetNeeded = total;
      method = `MTM exact (iterated ≤${maxIter} redeemers, no G set)`;
    } catch (e) {
      totalRedeemAssetNeeded = aggregateNeeded(batchKash, nav, feeBps, price, DECIMALS);
      method = `MTM aggregate (batchRedeemUsers failed: ${e.shortMessage || e.message})`;
    }
  } else {
    totalRedeemAssetNeeded = aggregateNeeded(batchKash, nav, feeBps, price, DECIMALS);
    method = `MTM aggregate (redeemUsersCount ${redeemUsersCount} > PHASE2_SHORTFALL_MAX_REDEEMERS=${maxIter})`;
  }

  if (mintFeeAsset === 0n && Number(info[3]) > 0) {
    mintFeeAsset = await computeMintFeeAsset(v, batchCycle);
  }

  const tolerance = BigInt(process.env.MARK_DONE_PAYOUT_TOLERANCE_ASSET || (IS_BTC ? "30" : "10000000000000"));
  const required = ownerReserve + mintFeeAsset + totalRedeemAssetNeeded;
  const missing = required > have + tolerance ? required - have - tolerance : 0n;

  console.log("\n  ── Phase 2 balance check (mirror contract) ───────────────");
  console.log(`  owner${IS_BTC ? "Wbtc" : "Eth"}Reserve:     ${fmtAsset(ownerReserve)}`);
  console.log(`  mint protocol fees:  ${fmtAsset(mintFeeAsset)}`);
  console.log(`  gross redeem (G):    ${fmtAsset(totalRedeemAssetNeeded)}  ← ${method}`);
  console.log(`  payout tolerance:    ${fmtAsset(tolerance)}`);
  console.log(`  required (all):      ${fmtAsset(required)}`);
  console.log(`  vault ${ASSET_SYMBOL} (have): ${fmtAsset(have)}`);
  console.log(`  missing (after tol): ${fmtAsset(missing)}`);
  if (missing > 0n) {
    console.log("\n  → Fund the vault with at least the missing amount, then retry Phase 2.");
  } else if (phase === 2 && !processed) {
    console.log("\n  → Sufficient for the InsufficientWbtcForRedeems / InsufficientEthForRedeems check at this NAV/price.");
  }

  if (method.startsWith("aggregate")) {
    console.log(
      "\n  Note: Aggregate uses one division; contract sums per-user (floor each step).",
    );
    console.log("        If estimate is within ~1–2 satoshi/wei of zero, add a tiny buffer.");
  }
  if (phase !== 2) {
    console.log(`\n  ⚠️  batchPhase is ${phase}, not 2 — shortfall math still shows obligation if you later reach Phase 2 at this NAV.`);
  }
  if (processed) {
    console.log("\n  ⚠️  Batch already processed; figures are historical.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
