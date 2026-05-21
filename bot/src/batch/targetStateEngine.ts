/**
 * Target-state ops engine — batches Hyperliquid + Aave flows via shared OpSteps (`opsExec`).
 *
 * Computes an illustrative target snapshot (deposit / borrow / short) for logs and dry-run,
 * then executes the same battle-tested txs as the legacy playbook with corrected **falling**
 * tail ordering: repay → Aave withdraw → USDC→asset swap for redeem gaps.
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
  type RedeemTail,
} from './opsClassifier';
import {
  runPlaybook,
  buildMintOpSteps,
  buildRedeemCoreOpSteps,
  buildRedeemTailOpStepsBalanced,
  buildRedeemTailOpStepsFalling,
  buildRedeemTailOpStepsRising,
  waitForHlWithdrawSettlementIfNeeded,
  computeDeployableNetMintUsd,
  computeNetMintAaveDepositAmount,
  readBatchMintDeployedToAave,
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
  const levScaled = BigInt(Math.round(config.strategy.shortLeverage * 100));

  if (scenario === 'net_mint_hl') {
    const depDelta = await computeNetMintAaveDepositAmount(ctx, netMintUSD);
    const supAfterUsd = suppliedUsd(ctx);
    const addUsd =
      ctx.isBtc
        ? (depDelta * ctx.price) / (10n ** 8n)
        : (depDelta * ctx.price) / (10n ** 18n);
    const targetBorrowUsdc = ((supAfterUsd + addUsd) * ltv) / 100n / (10n ** 12n);

    const deployUsd = await computeDeployableNetMintUsd(ctx, netMintUSD);
    const shortUsdInc = (deployUsd * levScaled) / 100n;
    const shortIncAssetNum = ctx.isBtc
      ? (shortUsdInc * (10n ** 8n)) / ctx.price
      : (shortUsdInc * (10n ** 18n)) / ctx.price;
    const shortIncInternal18 = ctx.isBtc
      ? (shortIncAssetNum * WAD) / (10n ** 8n)
      : shortIncAssetNum;

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

function logTargets(label: string, t: Targets, ctx: OpsContext): void {
  console.log(`   ${label} Δdeposit(asset)=${ethers.formatUnits(t.deltaAaveDepositAsset, Number(ctx.assetDecimals))} ${ctx.assetSymbol}`);
  console.log(
    `   ${label} ideal HL short≈${ethers.formatUnits(t.targetHlShortInternal18, 18)} ${ctx.assetSymbol} perp (18‑dec internal, informational)`,
  );
  console.log(`   ${label} ideal Aave borrow≈${ethers.formatUnits(t.targetAaveBorrowUsdc, 6)} USDC @ ${config.strategy.borrowLtvPct}% LTV`);
}

function redeemTailSteps(tail: RedeemTail, lockedNAV: bigint | undefined) {
  switch (tail) {
    case 'falling':
      return buildRedeemTailOpStepsFalling(lockedNAV);
    case 'rising':
      return buildRedeemTailOpStepsRising();
    case 'balanced':
      return buildRedeemTailOpStepsBalanced();
  }
}

/** Primary batch ops entry — replaces legacy `runMintPlaybook` / `runRedeemPlaybook`. */
export async function runTargetStateEngine(
  ctx: OpsContext,
  scenario: OpsScenario,
  netMintUSD: bigint,
  lockedNAV?: bigint,
): Promise<void> {
  if (scenario === 'net_mint_hl') {
    const minUsd = config.netMintSkipOpsMinUsd18;
    if (netMintUSD < minUsd) {
      console.log(
        `\n💰 NET_MINT (${ctx.assetSymbol}) — net ${fmtUsd(netMintUSD)} is below NET_MINT_SKIP_OPS_MIN_USDC (${fmtUsd(minUsd)}); skipping ops.\n`,
      );
      return;
    }

    console.log(`\n💰 NET_MINT (${ctx.assetSymbol}) — deploying ${fmtUsd(netMintUSD)} net capital (target-state engine)\n`);

    const targets = await computeTargets(ctx, scenario, netMintUSD);
    console.log('   ─── Mint targets (batch sizing vs snapshot) ───');
    console.log(
      `   deployUSD(after fee − redeem USD)=${fmtUsd(await computeDeployableNetMintUsd(ctx, netMintUSD))}, ` +
        `batchDepositTracked=${ethers.formatUnits(await readBatchMintDeployedToAave(ctx), Number(ctx.assetDecimals))} ${ctx.assetSymbol}`,
    );
    logTargets('mint', targets, ctx);
    console.log('');

    await runPlaybook(buildMintOpSteps(netMintUSD), ctx);
    return;
  }

  if (scenario === 'redeem_hl') {
    console.log(
      `\n💸 NET_REDEEM (${ctx.assetSymbol}) — gross redeem ${(Number(ctx.redeemFraction) / 1e16).toFixed(2)}%, ` +
        `strategy unwind ${(Number(ctx.strategyRedeemFraction) / 1e16).toFixed(2)}% (target-state engine)\n`,
    );

    const targets = await computeTargets(ctx, scenario, netMintUSD);
    console.log('   ─── Redeem targets (illustrative unwind vs snapshot) ───');
    logTargets('redeem', targets, ctx);
    console.log('');

    await runPlaybook(buildRedeemCoreOpSteps(), ctx);

    let freshCtx = await snapshotOpsContext(ctx.kashYield, ctx.provider, ctx.batchCycle, lockedNAV);
    freshCtx.aaveDebtFloor = strategyAaveDebtFloor(freshCtx);
    freshCtx = await waitForHlWithdrawSettlementIfNeeded(freshCtx, lockedNAV);

    const tail = classifyRedeemTail(freshCtx);
    console.log(`   📊 Redeem tail: ${tailLabel(tail)}`);
    console.log(
      `      contractUsdc=${ethers.formatUnits(freshCtx.contractUsdc, 6)} USDC, ` +
        `strategyDebt=${ethers.formatUnits(strategyAaveDebtToRepay(freshCtx), 6)} USDC, ` +
        `totalDebt=${ethers.formatUnits(freshCtx.aaveDebt, 6)} USDC\n`,
    );

    await runPlaybook(redeemTailSteps(tail, lockedNAV), freshCtx);
  }
}
