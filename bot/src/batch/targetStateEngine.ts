/**
 * Target-state ops engine (phase 2): **computed mint deltas** for pre-flight logs +
 * **delta pipelines** (`execute*DeltaPipeline` in `opsExec`) instead of generic `runPlaybook`
 * for NET_MINT / NET_REDEEM batch ops.
 *
 * Redeem **falling** tail order remains: repay → Aave withdraw → 11b swap.
 */

import { ethers } from 'ethers';
import { config } from '../config';
import type { OpsContext } from './opsContext';
import { snapshotOpsContext } from './opsContext';
import type { OpsScenario } from './opsClassifier';
import {
  classifyRedeemTail,
  tailLabel,
  strategyAaveDebtToRepay,
  strategyAaveDebtFloor,
} from './opsClassifier';
import {
  waitForHlWithdrawSettlementIfNeeded,
  computeDeployableNetMintUsd,
  computeNetMintAaveDepositAmount,
  readBatchMintDeployedToAave,
  getAaveAvailableBorrowUsdc6,
  executeMintDeltaPipeline,
  executeRedeemCoreDeltaPipeline,
  executeRedeemTailDeltaPipeline,
  mintShortIncrementInternal18,
  openShortAssetEstimateFromDeposit,
} from './opsExec';

const WAD = 10n ** 18n;

export interface Targets {
  /** Intended incremental Aave collateral from this batch’s net mint (asset decimals). */
  deltaAaveDepositAsset: bigint;
  /** Illustrative ideal HL short spot size after unwind (18‑dec internal perp units — informational only). */
  targetHlShortInternal18: bigint;
  /** Target USDC debt if collateral matched ideal deposit × LTV (6 dec). */
  targetAaveBorrowUsdc: bigint;
}

/** Pre-execution mint Δ estimates (snapshot-time; refreshed on-chain state may differ slightly). */
export interface MintDeltas {
  depositAsset: bigint;
  borrowDeltaUsdcEstimate: bigint;
  hlDepositUsdcEstimate: bigint;
  openShortAssetEstimate: bigint;
}

function fmtUsd(v: bigint): string {
  return '$' + ethers.formatEther(v);
}

function suppliedUsd(ctx: OpsContext): bigint {
  return ctx.isBtc
    ? (ctx.aaveSupplied * ctx.price) / (10n ** 8n)
    : (ctx.aaveSupplied * ctx.price) / (10n ** 18n);
}

/**
 * Mint targets mirror legacy `computeNetMintAaveDepositAmount` + LTV borrow goals.
 * Redeem targets use strategy unwind fraction on current supplied / short for diagnostics.
 */
export async function computeTargets(
  ctx: OpsContext,
  scenario: OpsScenario,
  netMintUSD: bigint,
): Promise<Targets> {
  const ltv = BigInt(config.strategy.borrowLtvPct);

  if (scenario === 'net_mint_hl') {
    const depDelta = await computeNetMintAaveDepositAmount(ctx, netMintUSD);
    const supAfterUsd = suppliedUsd(ctx);
    const addUsd =
      ctx.isBtc
        ? (depDelta * ctx.price) / (10n ** 8n)
        : (depDelta * ctx.price) / (10n ** 18n);
    const targetBorrowUsdc = ((supAfterUsd + addUsd) * ltv) / 100n / (10n ** 12n);

    const shortIncInternal18 = mintShortIncrementInternal18(ctx, depDelta);

    return {
      deltaAaveDepositAsset: depDelta,
      targetHlShortInternal18: ctx.shortSize + shortIncInternal18,
      targetAaveBorrowUsdc: targetBorrowUsdc,
    };
  }

  const f = ctx.strategyRedeemFraction;
  const depositAfter = f >= WAD ? 0n : (ctx.aaveSupplied * (WAD - f)) / WAD;
  const depositAfterUsd = ctx.isBtc
    ? (depositAfter * ctx.price) / (10n ** 8n)
    : (depositAfter * ctx.price) / (10n ** 18n);
  const shortAfter = f >= WAD ? 0n : (ctx.shortSize * (WAD - f)) / WAD;

  return {
    deltaAaveDepositAsset: depositAfter > ctx.aaveSupplied ? 0n : ctx.aaveSupplied - depositAfter,
    targetHlShortInternal18: shortAfter,
    targetAaveBorrowUsdc: (depositAfterUsd * ltv) / 100n / (10n ** 12n),
  };
}

/**
 * Structured mint deltas after deposit+borrow estimates (matches `hlDepositUsdcAmount` intent post-borrow).
 * `openShortAssetEstimate` = batch Aave deposit × SHORT_LEVERAGE (at 1x, short notional = deposit USD).
 */
export async function computeMintDeltas(
  ctx: OpsContext,
  netMintUSD: bigint,
  _targets: Targets,
): Promise<MintDeltas> {
  const depositAsset = await computeNetMintAaveDepositAmount(ctx, netMintUSD);
  const addUsd =
    ctx.isBtc
      ? (depositAsset * ctx.price) / (10n ** 8n)
      : (depositAsset * ctx.price) / (10n ** 18n);
  const supAfterUsd = suppliedUsd(ctx) + addUsd;
  const ltv = BigInt(config.strategy.borrowLtvPct);
  const targetDebtUsdc = (supAfterUsd * ltv) / 100n / (10n ** 12n);
  let borrowDeltaUsdcEstimate =
    targetDebtUsdc > ctx.aaveDebt ? targetDebtUsdc - ctx.aaveDebt : 0n;
  const avail = await getAaveAvailableBorrowUsdc6(ctx);
  if (borrowDeltaUsdcEstimate > avail) {
    borrowDeltaUsdcEstimate = avail;
  }

  const cPost = ctx.contractUsdc + borrowDeltaUsdcEstimate;
  const dPost = ctx.aaveDebt + borrowDeltaUsdcEstimate;
  let hlDepositUsdcEstimate = 0n;
  if (cPost > 0n) {
    hlDepositUsdcEstimate = dPost === 0n ? cPost : cPost < dPost ? cPost : dPost;
  }

  const openShortAssetEstimate = openShortAssetEstimateFromDeposit(ctx, depositAsset);

  return {
    depositAsset,
    borrowDeltaUsdcEstimate,
    hlDepositUsdcEstimate,
    openShortAssetEstimate,
  };
}

function logTargets(label: string, t: Targets, ctx: OpsContext): void {
  const lev = config.strategy.shortLeverage;
  const depositUsd =
    ctx.isBtc
      ? (t.deltaAaveDepositAsset * ctx.price) / (10n ** 8n)
      : (t.deltaAaveDepositAsset * ctx.price) / (10n ** 18n);
  console.log(`   ${label} Δdeposit(asset)=${ethers.formatUnits(t.deltaAaveDepositAsset, Number(ctx.assetDecimals))} ${ctx.assetSymbol}`);
  console.log(
    `   ${label} ideal HL short≈${ethers.formatUnits(t.targetHlShortInternal18, 18)} ${ctx.assetSymbol} perp ` +
      `(current + depositUSD × ${lev}; at 1x short notional = deposit USD ≈ ${fmtUsd(depositUsd)})`,
  );
  console.log(`   ${label} ideal Aave borrow≈${ethers.formatUnits(t.targetAaveBorrowUsdc, 6)} USDC @ ${config.strategy.borrowLtvPct}% LTV`);
}

function logMintDeltas(d: MintDeltas, ctx: OpsContext): void {
  const lev = config.strategy.shortLeverage;
  console.log(
    `   Δborrow(usdc, est)=${ethers.formatUnits(d.borrowDeltaUsdcEstimate, 6)} USDC ` +
      `(Aave headroom-capped); ΔhlDeposit(usdc, est)=${ethers.formatUnits(d.hlDepositUsdcEstimate, 6)} USDC`,
  );
  console.log(
    `   ΔopenShort(asset, est)=${ethers.formatUnits(d.openShortAssetEstimate, Number(ctx.assetDecimals))} ${ctx.assetSymbol} ` +
      `(batch Aave deposit × ${lev}x; execute uses on-chain batchMintDeployedToAave)`,
  );
}

/** Primary batch ops entry — replaces legacy `runMintPlaybook` / `runRedeemPlaybook`. */
export async function runTargetStateEngine(
  ctx: OpsContext,
  scenario: OpsScenario,
  netMintUSD: bigint,
  lockedNAV?: bigint,
): Promise<void> {
  if (scenario === 'net_mint_hl') {
    console.log(`\n💰 NET_MINT (${ctx.assetSymbol}) — deploying ${fmtUsd(netMintUSD)} net capital (delta engine phase 2)\n`);

    const targets = await computeTargets(ctx, scenario, netMintUSD);
    const mintDeltas = await computeMintDeltas(ctx, netMintUSD, targets);

    const estShortInternal = mintShortIncrementInternal18(ctx, targets.deltaAaveDepositAsset);

    console.log('   ─── Mint targets (batch sizing vs snapshot) ───');
    console.log(
      `   deployUSD(after fee − redeem USD)=${fmtUsd(await computeDeployableNetMintUsd(ctx, netMintUSD))}, ` +
        `batchDepositTracked=${ethers.formatUnits(await readBatchMintDeployedToAave(ctx), Number(ctx.assetDecimals))} ${ctx.assetSymbol}`,
    );
    logTargets('mint', targets, ctx);
    console.log('   ─── Mint deltas (estimated, pre-run) ───');
    console.log(
      `   Δdeposit(asset)=${ethers.formatUnits(mintDeltas.depositAsset, Number(ctx.assetDecimals))} ${ctx.assetSymbol}`,
    );
    logMintDeltas(mintDeltas, ctx);
    console.log(
      `   Δshort(internal, est)=${ethers.formatUnits(estShortInternal, 18)} ` +
        `(batch Aave deposit USD × ${config.strategy.shortLeverage}; openShort reads batchMintDeployedToAave at execute)`,
    );
    console.log('');

    await executeMintDeltaPipeline(ctx, netMintUSD, {
      initialShortInternal18: ctx.shortSize,
      depositAssetEstimate: targets.deltaAaveDepositAsset,
    });
    return;
  }

  if (scenario === 'redeem_hl') {
    console.log(
      `\n💸 NET_REDEEM (${ctx.assetSymbol}) — gross redeem ${(Number(ctx.redeemFraction) / 1e16).toFixed(2)}%, ` +
        `strategy unwind ${(Number(ctx.strategyRedeemFraction) / 1e16).toFixed(2)}% (delta engine phase 2)\n`,
    );

    const targets = await computeTargets(ctx, scenario, netMintUSD);
    console.log('   ─── Redeem targets (illustrative unwind vs snapshot) ───');
    logTargets('redeem', targets, ctx);
    console.log(
      '   ─── Redeem deltas (execution order: Δredeem hl_close_short → HL settlement (withdraw3 + target pull) → tail phases) ───\n',
    );

    await executeRedeemCoreDeltaPipeline(ctx);

    let freshCtx = await snapshotOpsContext(ctx.kashYield, ctx.provider, ctx.signer, ctx.batchCycle, lockedNAV);
    freshCtx.aaveDebtFloor = strategyAaveDebtFloor(freshCtx);
    freshCtx = await waitForHlWithdrawSettlementIfNeeded(freshCtx, lockedNAV);

    const tail = classifyRedeemTail(freshCtx);
    console.log(`   📊 Redeem tail: ${tailLabel(tail)}`);
    console.log(
      `      contractUsdc=${ethers.formatUnits(freshCtx.contractUsdc, 6)} USDC, ` +
        `strategyDebt=${ethers.formatUnits(strategyAaveDebtToRepay(freshCtx), 6)} USDC, ` +
        `totalDebt=${ethers.formatUnits(freshCtx.aaveDebt, 6)} USDC\n`,
    );

    await executeRedeemTailDeltaPipeline(freshCtx, tail, lockedNAV);
  }
}
