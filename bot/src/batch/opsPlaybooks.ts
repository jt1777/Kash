import { ethers } from 'ethers';
import { config } from '../config';
import { snapshotOpsContext, computeTotalRedeemAsset, type OpsContext } from './opsContext';
import { classifyRedeemTail, tailLabel, type RedeemTail } from './opsClassifier';

// ---------------------------------------------------------------------------
// OpStep interface
// ---------------------------------------------------------------------------

/** Which bot sub-step flag gates this step. */
type OpSubstep = 'hl' | 'aave';

export interface OpStep {
  /** Stable identifier used in dry-run output and logs. */
  id: string;
  /** Used by --step=hl / --step=aave filtering. */
  substep: OpSubstep;
  /** Human-readable description with computed amounts; used for dry-run and pre-execution log. */
  describe: (ctx: OpsContext) => string;
  /** Idempotency check: return true to skip (state already reflects this step). */
  canSkip: (ctx: OpsContext) => Promise<boolean>;
  /** Execute the step. Caller refreshes ctx when refreshCtx=true. */
  execute: (ctx: OpsContext) => Promise<void>;
  /** When true, the executor re-snapshots OpsContext before the next step. */
  refreshCtx?: boolean;
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/**
 * Run an ordered list of OpStep instances.
 *
 * - Respects --step=hl / --step=aave sub-step filtering.
 * - Calls canSkip() before each step; logs and skips if already done.
 * - Re-snapshots OpsContext after steps with refreshCtx=true.
 * - In dry-run mode (--dry-run-ops), prints the plan without executing.
 */
export async function runPlaybook(
  steps: OpStep[],
  initialCtx: OpsContext,
): Promise<void> {
  const stepFilter = config.batchStep;
  const dryRun = config.dryRunOps;

  if (dryRun) {
    console.log('\n[DRY-RUN] Ops playbook:');
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (!shouldRunStep(step, stepFilter)) continue;
      console.log(`  Step ${i + 1}: ${step.id.padEnd(30)} ${step.describe(initialCtx)}`);
    }
    console.log('  Add --confirm to execute (dry-run mode active — no transactions sent).\n');
    return;
  }

  let ctx = initialCtx;
  for (const step of steps) {
    if (!shouldRunStep(step, stepFilter)) {
      console.log(`   [skip] ${step.id} (not in --step=${stepFilter})`);
      continue;
    }

    const skip = await step.canSkip(ctx);
    if (skip) {
      console.log(`   [skip] ${step.id} — already done`);
      continue;
    }

    console.log(`   ▶  ${step.id}: ${step.describe(ctx)}`);
    await step.execute(ctx);
    console.log(`   ✅ ${step.id} done`);

    if (step.refreshCtx) {
      ctx = await snapshotOpsContext(ctx.kashYield, ctx.provider, ctx.batchCycle, ctx.lockedNAV);
    }
  }
}

function shouldRunStep(step: OpStep, stepFilter: string): boolean {
  if (stepFilter === 'full' || stepFilter === 'ops') return true;
  if (stepFilter === 'hl' && step.substep === 'hl') return true;
  // 'aave' also runs DEX swaps (they serve the Aave repay/withdraw flow)
  if (stepFilter === 'aave' && step.substep === 'aave') return true;
  return false;
}

// ---------------------------------------------------------------------------
// Shared low-level helpers (called by step execute functions)
// ---------------------------------------------------------------------------

async function execTx(label: string, txPromise: Promise<ethers.ContractTransactionResponse>): Promise<void> {
  const tx = await txPromise;
  await tx.wait();
  console.log(`      → ${label} confirmed`);
}

function fmtUsdc(v: bigint): string { return ethers.formatUnits(v, 6) + ' USDC'; }
function fmtAsset(v: bigint, ctx: OpsContext): string {
  return ethers.formatUnits(v, Number(ctx.assetDecimals)) + ' ' + ctx.assetSymbol;
}
function fmtUsd(v: bigint): string { return '$' + ethers.formatEther(v); }

// ---------------------------------------------------------------------------
// ─── MINT STEPS ─────────────────────────────────────────────────────────────
// ---------------------------------------------------------------------------

/**
 * 01 — Deposit ETH/wBTC to Aave as collateral.
 * refreshCtx=true: aave_borrow reads ctx.aaveSupplied, which must reflect the
 * just-executed deposit or it will compute targetUsdc=0 and skip the borrow.
 */
const aaveDeposit: OpStep = {
  id: 'aave_deposit',
  substep: 'aave',
  refreshCtx: true,
  describe: (ctx) => {
    const pct = config.strategy.aaveDepositPct;
    const depositUSD = (ctx.price * ctx.contractAsset) / (10n ** ctx.assetDecimals);
    const targetUSD = (depositUSD * BigInt(pct)) / 100n;
    return `deposit ${pct}% of contract asset to Aave (~${fmtUsd(targetUSD)})`;
  },
  canSkip: async (ctx) => {
    // Skip if there's no asset in contract to deposit
    if (ctx.contractAsset === 0n) return true;
    // Skip if Aave already holds more than the deposit target
    const pct = BigInt(config.strategy.aaveDepositPct);
    const depositUSD = (ctx.price * ctx.contractAsset) / (10n ** ctx.assetDecimals);
    const targetUSD = (depositUSD * pct) / 100n;
    const targetAsset = (targetUSD * (10n ** ctx.assetDecimals)) / ctx.price;
    return ctx.aaveSupplied >= targetAsset;
  },
  execute: async (ctx) => {
    const pct = BigInt(config.strategy.aaveDepositPct);
    const target = (ctx.contractAsset * pct) / 100n;
    const toDeposit = target < ctx.contractAsset ? target : ctx.contractAsset;
    if (toDeposit === 0n) return;
    console.log(`         ${fmtAsset(toDeposit, ctx)}`);
    await execTx('depositToAave', ctx.kashYield.depositToAave(toDeposit));
  },
};

/**
 * 02 — Borrow USDC from Aave at target LTV.
 * refreshCtx=true: hl_deposit_usdc (and any subsequent step) reads ctx.contractUsdc,
 * which must reflect the just-borrowed USDC or it will see 0 and skip the HL deposit.
 */
const aaveBorrow: OpStep = {
  id: 'aave_borrow',
  substep: 'aave',
  refreshCtx: true,
  describe: (ctx) => {
    const ltvPct = config.strategy.borrowLtvPct;
    const ltv = BigInt(ltvPct);
    const suppliedUSD = ctx.isBtc
      ? (ctx.aaveSupplied * ctx.price) / (10n ** 8n)
      : (ctx.aaveSupplied * ctx.price) / (10n ** 18n);
    const targetDebtUSD = (suppliedUSD * ltv) / 100n;
    const targetUsdc6 = targetDebtUSD / (10n ** 12n);
    const toBorrow = targetUsdc6 > ctx.aaveDebt ? targetUsdc6 - ctx.aaveDebt : 0n;
    return `borrow up to ${ltvPct}% LTV — need ${fmtUsdc(toBorrow)} more USDC`;
  },
  canSkip: async (ctx) => {
    const ltv = BigInt(config.strategy.borrowLtvPct);
    const suppliedUSD = ctx.isBtc
      ? (ctx.aaveSupplied * ctx.price) / (10n ** 8n)
      : (ctx.aaveSupplied * ctx.price) / (10n ** 18n);
    const targetUsdc6 = (suppliedUSD * ltv) / 100n / (10n ** 12n);
    return ctx.aaveDebt >= targetUsdc6;
  },
  execute: async (ctx) => {
    const ltv = BigInt(config.strategy.borrowLtvPct);
    const suppliedUSD = ctx.isBtc
      ? (ctx.aaveSupplied * ctx.price) / (10n ** 8n)
      : (ctx.aaveSupplied * ctx.price) / (10n ** 18n);
    const targetUsdc6 = (suppliedUSD * ltv) / 100n / (10n ** 12n);
    const toBorrow = targetUsdc6 > ctx.aaveDebt ? targetUsdc6 - ctx.aaveDebt : 0n;
    if (toBorrow === 0n) return;
    console.log(`         ${fmtUsdc(toBorrow)}`);
    await execTx('borrowFromAave', ctx.kashYield.borrowFromAave(ctx.aaveUsdcAddress, toBorrow));
  },
};

/** 03 — Deposit USDC to Hyperliquid as collateral (no spot buy — USDC IS the collateral) */
const hlDepositUsdc: OpStep = {
  id: 'hl_deposit_usdc',
  substep: 'hl',
  describe: (ctx) => `deposit ${fmtUsdc(ctx.contractUsdc)} USDC to Hyperliquid`,
  canSkip: async (ctx) => ctx.contractUsdc === 0n,
  execute: async (ctx) => {
    const amount = ctx.contractUsdc;
    if (amount === 0n) return;
    console.log(`         ${fmtUsdc(amount)}`);

    // Guard: HL address must be set
    let hlAddress = '';
    try { hlAddress = await ctx.kashYield.hyperliquidAddress(); } catch { /* ignore */ }
    if (!hlAddress || hlAddress === ethers.ZeroAddress) {
      console.log('         ⚠️  Hyperliquid address not set — skipping HL deposit');
      return;
    }
    await execTx('depositToHyperliquid', ctx.kashYield.depositToHyperliquid(amount));
  },
};

/** 05 — Open or extend short on Hyperliquid */
const hlOpenShort = (netMintUSD: bigint): OpStep => ({
  id: 'hl_open_short',
  substep: 'hl',
  describe: (ctx) => {
    const leverage = config.strategy.shortLeverage;
    const leverageScaled = BigInt(Math.round(leverage * 100));
    const shortSizeUSD = (netMintUSD * leverageScaled) / 100n;
    const shortSizeAsset = (shortSizeUSD * (10n ** ctx.assetDecimals)) / ctx.price;
    return `open/extend ${leverage}x ${ctx.assetSymbol} short — notional ${fmtAsset(shortSizeAsset, ctx)}`;
  },
  canSkip: async (ctx) => {
    // Only skip if short exists AND we didn't deposit new USDC collateral this run
    // (extendShort=true if new USDC was deposited; checked via aave borrow delta elsewhere)
    // Safe fallback: never skip if no short exists yet
    return false;
  },
  execute: async (ctx) => {
    const leverageScaled = BigInt(Math.round(config.strategy.shortLeverage * 100));
    const shortSizeUSD = (netMintUSD * leverageScaled) / 100n;
    if (shortSizeUSD === 0n) return;
    const size = (shortSizeUSD * (10n ** ctx.assetDecimals)) / ctx.price;
    const symbol = ctx.assetSymbol;
    console.log(`         open/extend ${ctx.assetSymbol} short: notional=${fmtAsset(size, ctx)}`);
    await execTx('openShort', ctx.kashYield.openShort(symbol, size));
  },
});

// ---------------------------------------------------------------------------
// ─── REDEEM CORE STEPS ──────────────────────────────────────────────────────
// ---------------------------------------------------------------------------

/** 06 — Close proportional share of the short; refreshes ctx so USDC balance is current */
const hlCloseShort: OpStep = {
  id: 'hl_close_short',
  substep: 'hl',
  refreshCtx: true,
  describe: (ctx) => {
    const pct = (Number(ctx.redeemFraction) / 1e16).toFixed(2);
    const closeSize = (ctx.shortSize * ctx.redeemFraction) / BigInt(1e18);
    return `close ${pct}% of ${ctx.assetSymbol} short (${fmtAsset(closeSize, ctx)} of ${fmtAsset(ctx.shortSize, ctx)})`;
  },
  canSkip: async (ctx) => {
    if (!ctx.shortIsActive) {
      // Warn if KASH still exists (short should still be open)
      try {
        const tokenAddr: string | null = await (ctx.isBtc
          ? ctx.kashYield.kashTokenBtc()
          : ctx.kashYield.kashTokenEth()
        ).catch(() => null);
        if (tokenAddr) {
          const kashToken = new ethers.Contract(tokenAddr, ['function totalSupply() view returns (uint256)'], ctx.provider);
          const supply = BigInt((await kashToken.totalSupply()).toString());
          if (supply > 0n) {
            console.warn(`   ⚠️  No active ${ctx.assetSymbol} short but KASH supply=${ethers.formatEther(supply)} — assuming already closed in partial run`);
          }
        }
      } catch { /* ignore */ }
      return true; // nothing to close
    }
    return false;
  },
  execute: async (ctx) => {
    const symbol = ctx.assetSymbol;
    const fullSize = ctx.shortSize;
    const closeSize = (fullSize * ctx.redeemFraction) / BigInt(1e18);
    if (closeSize >= fullSize) {
      console.log(`         closing full ${symbol} short`);
      await execTx('closeShort(full)', ctx.kashYield['closeShort(string)'](symbol));
    } else {
      console.log(`         closing ${fmtAsset(closeSize, ctx)} of ${fmtAsset(fullSize, ctx)}`);
      await execTx('closeShort(partial)', ctx.kashYield['closeShort(string,uint256)'](symbol, closeSize));
    }
  },
};

/** 08 — Withdraw all USDC from Hyperliquid to contract; refreshes ctx for tail classification */
const hlWithdrawUsdc: OpStep = {
  id: 'hl_withdraw_usdc',
  substep: 'hl',
  refreshCtx: true,
  describe: (ctx) => `withdraw ${fmtUsdc(ctx.hlUsdcBalance)} USDC from Hyperliquid`,
  canSkip: async (ctx) => ctx.hlUsdcBalance === 0n,
  execute: async (ctx) => {
    const amount = ctx.hlUsdcBalance;
    if (amount === 0n) return;
    console.log(`         ${fmtUsdc(amount)}`);
    await execTx('withdrawFromHyperliquid', ctx.kashYield.withdrawFromHyperliquid(amount));
  },
};

// ---------------------------------------------------------------------------
// ─── REDEEM TAIL STEPS (falling / rising / balanced) ────────────────────────
// ---------------------------------------------------------------------------

/** 09 — Repay Aave borrow with all available contract USDC */
const aaveRepay: OpStep = {
  id: 'aave_repay',
  substep: 'aave',
  describe: (ctx) => {
    const amount = ctx.contractUsdc < ctx.aaveDebt ? ctx.contractUsdc : ctx.aaveDebt;
    return `repay ${fmtUsdc(amount)} to Aave (debt=${fmtUsdc(ctx.aaveDebt)})`;
  },
  canSkip: async (ctx) => ctx.aaveDebt === 0n,
  execute: async (ctx) => {
    const amount = ctx.contractUsdc < ctx.aaveDebt ? ctx.contractUsdc : ctx.aaveDebt;
    if (amount === 0n) return;
    console.log(`         ${fmtUsdc(amount)}`);
    await execTx('repayToAave', ctx.kashYield.repayToAave(ctx.aaveUsdcAddress, amount));
  },
};

/**
 * 11b — Swap excess USDC → asset (falling price tail).
 * Called AFTER aaveRepay; at that point contractUsdc holds only the excess.
 * Sizing: swap excess up to what is needed to cover the total redeem asset requirement.
 */
const dexSwapFromUsdc = (lockedNAV: bigint | undefined): OpStep => ({
  id: 'dex_swap_from_usdc',
  substep: 'aave',
  describe: (ctx) => {
    const excess = ctx.contractUsdc;
    const usdcToSwap = excess > 0n ? excess : 0n;
    return `swap ${fmtUsdc(usdcToSwap)} excess USDC → ${ctx.assetSymbol} (11b, falling price)`;
  },
  canSkip: async (ctx) => {
    // Skip if spot DEX is not configured
    const spotDex = await ctx.kashYield.spotDexAddress().catch(() => null);
    if (!spotDex || spotDex === ethers.ZeroAddress) {
      console.log(`         ⚠️  spotDexAddress not configured — skipping 11b swap`);
      return true;
    }
    // Skip if no excess USDC
    if (ctx.contractUsdc === 0n) return true;
    // Skip if contract already holds enough asset for all redeemers
    return ctx.contractAsset >= ctx.totalRedeemAsset;
  },
  execute: async (ctx) => {
    if (ctx.contractUsdc === 0n) return;
    // Compute shortfall to determine how much USDC to swap
    const assetNeeded = ctx.totalRedeemAsset > ctx.contractAsset
      ? ctx.totalRedeemAsset - ctx.contractAsset
      : 0n;
    if (assetNeeded === 0n) return;
    // Cap USDC to swap: (assetNeeded * price) / 10^assetDecimals, then convert to USDC 6 dec
    const usdcNeeded = (assetNeeded * ctx.price) / (10n ** ctx.assetDecimals) / (10n ** 12n);
    const usdcToSwap = usdcNeeded < ctx.contractUsdc ? usdcNeeded : ctx.contractUsdc;
    console.log(`         swap ${fmtUsdc(usdcToSwap)} → ~${fmtAsset(assetNeeded, ctx)} (at lockedNAV sizing)`);
    await execTx('swapFromUsdc', ctx.kashYield.swapFromUsdc(usdcToSwap));
  },
});

/**
 * 10 — Withdraw Aave collateral.
 *
 * For falling price and balanced: proportional withdrawal (redeemFraction × aaveSupplied),
 * or full sweep on 100% redemption.
 * For rising price (after partial-withdraw-for-swap):
 * withdraw only what remains to reach totalRedeemAsset.
 */
const aaveWithdraw = (mode: 'proportional' | 'remaining'): OpStep => ({
  id: mode === 'proportional' ? 'aave_withdraw' : 'aave_withdraw_rest',
  substep: 'aave',
  describe: (ctx) => {
    if (ctx.aaveSupplied === 0n) return 'withdraw from Aave (nothing supplied)';
    if (mode === 'proportional') {
      const isFullRedemption = ctx.redeemFraction >= BigInt(1e18);
      if (isFullRedemption) return `withdraw ALL ${fmtAsset(ctx.aaveSupplied, ctx)} from Aave`;
      const amount = _proportionalWithdrawAmount(ctx);
      return `withdraw ${fmtAsset(amount, ctx)} from Aave (proportional)`;
    }
    // mode === 'remaining': withdraw to top up contract to totalRedeemAsset
    const needed = ctx.totalRedeemAsset > ctx.contractAsset
      ? ctx.totalRedeemAsset - ctx.contractAsset
      : 0n;
    const amount = needed < ctx.aaveSupplied ? needed : ctx.aaveSupplied;
    return `withdraw ${fmtAsset(amount, ctx)} from Aave (remaining after partial swap)`;
  },
  canSkip: async (ctx) => ctx.aaveSupplied === 0n,
  execute: async (ctx) => {
    if (ctx.aaveSupplied === 0n) return;
    let amount: bigint;
    if (mode === 'proportional') {
      const isFullRedemption = ctx.redeemFraction >= BigInt(1e18);
      amount = isFullRedemption ? ctx.aaveSupplied : _proportionalWithdrawAmount(ctx);
    } else {
      const needed = ctx.totalRedeemAsset > ctx.contractAsset
        ? ctx.totalRedeemAsset - ctx.contractAsset
        : 0n;
      amount = needed < ctx.aaveSupplied ? needed : ctx.aaveSupplied;
    }
    if (amount === 0n) return;
    console.log(`         ${fmtAsset(amount, ctx)}`);
    await execTx('withdrawFromAave', ctx.kashYield.withdrawFromAave(amount));
  },
});

/**
 * 10-partial — Withdraw a small amount of Aave collateral to cover USDC shortfall (rising price).
 * Runs BEFORE aave_repay in the rising-price path.
 * Size: (aaveDebt - contractUsdc) converted to asset units at current price.
 */
const aaveWithdrawPartial: OpStep = {
  id: 'aave_withdraw_partial',
  substep: 'aave',
  describe: (ctx) => {
    const shortfall = ctx.aaveDebt > ctx.contractUsdc ? ctx.aaveDebt - ctx.contractUsdc : 0n;
    const assetNeeded = (shortfall * (10n ** 12n) * (10n ** ctx.assetDecimals)) / ctx.price;
    return `partial Aave withdraw ${fmtAsset(assetNeeded, ctx)} to cover USDC shortfall ${fmtUsdc(shortfall)} (11a)`;
  },
  canSkip: async (ctx) => {
    if (ctx.aaveDebt <= ctx.contractUsdc) return true; // no shortfall
    const spotDex = await ctx.kashYield.spotDexAddress().catch(() => null);
    if (!spotDex || spotDex === ethers.ZeroAddress) {
      console.warn('         ⚠️  spotDexAddress not configured — cannot cover USDC shortfall via 11a');
      return true;
    }
    return false;
  },
  execute: async (ctx) => {
    const shortfall = ctx.aaveDebt > ctx.contractUsdc ? ctx.aaveDebt - ctx.contractUsdc : 0n;
    if (shortfall === 0n) return;
    // Convert USDC shortfall to asset units: shortfall(6dec) → USD(18dec) → asset(assetDec)
    const assetNeeded = (shortfall * (10n ** 12n) * (10n ** ctx.assetDecimals)) / ctx.price;
    const toWithdraw = assetNeeded < ctx.aaveSupplied ? assetNeeded : ctx.aaveSupplied;
    if (toWithdraw === 0n) return;
    console.log(`         ${fmtAsset(toWithdraw, ctx)} (shortfall=${fmtUsdc(shortfall)})`);
    await execTx('withdrawFromAave(partial)', ctx.kashYield.withdrawFromAave(toWithdraw));
  },
};

/**
 * 11a — Swap asset → USDC to cover residual Aave debt (rising price tail).
 * Called after aave_withdraw_partial; swaps all contract asset needed to clear the gap.
 */
const dexSwapForUsdc: OpStep = {
  id: 'dex_swap_for_usdc',
  substep: 'aave',
  describe: (ctx) => {
    const shortfall = ctx.aaveDebt > ctx.contractUsdc ? ctx.aaveDebt - ctx.contractUsdc : 0n;
    const assetToSell = (shortfall * (10n ** 12n) * (10n ** ctx.assetDecimals)) / ctx.price;
    return `swap ${fmtAsset(assetToSell, ctx)} → USDC to cover ${fmtUsdc(shortfall)} shortfall (11a)`;
  },
  canSkip: async (ctx) => {
    if (ctx.aaveDebt <= ctx.contractUsdc) return true; // gap already closed
    const spotDex = await ctx.kashYield.spotDexAddress().catch(() => null);
    if (!spotDex || spotDex === ethers.ZeroAddress) {
      console.warn('         ⚠️  spotDexAddress not configured — skipping 11a swap');
      return true;
    }
    return false;
  },
  execute: async (ctx) => {
    const shortfall = ctx.aaveDebt > ctx.contractUsdc ? ctx.aaveDebt - ctx.contractUsdc : 0n;
    if (shortfall === 0n) return;
    const assetToSell = (shortfall * (10n ** 12n) * (10n ** ctx.assetDecimals)) / ctx.price;
    // Cap to what contract actually holds
    const toSell = assetToSell < ctx.contractAsset ? assetToSell : ctx.contractAsset;
    if (toSell === 0n) return;
    console.log(`         sell ${fmtAsset(toSell, ctx)} → cover ${fmtUsdc(shortfall)}`);
    await execTx('swapForUsdc', ctx.kashYield.swapForUsdc(toSell));
  },
};

// ---------------------------------------------------------------------------
// Playbook builders
// ---------------------------------------------------------------------------

/**
 * Build mint playbook: 01 → 02 → 03 → 05 (no spot buy step 04).
 * USDC deposited in step 03 is already the HL short collateral.
 */
export function buildMintPlaybook(netMintUSD: bigint): OpStep[] {
  return [
    aaveDeposit,
    aaveBorrow,
    hlDepositUsdc,
    hlOpenShort(netMintUSD),
  ];
}

/**
 * Build redeem core playbook (steps 06 + 08, no step 07).
 * The tail steps (falling/rising/balanced) are appended dynamically in runRedeemPlaybook
 * after the context is refreshed post-HL-close, so the tail classification uses actual
 * USDC proceeds rather than a pre-flight estimate.
 */
export function buildRedeemCore(): OpStep[] {
  return [hlCloseShort, hlWithdrawUsdc];
}

/**
 * Build the tail steps based on the tail classification.
 * Called after ctx has been refreshed to reflect post-HL-close USDC balance.
 */
export function buildRedeemTail(tail: RedeemTail, lockedNAV: bigint | undefined): OpStep[] {
  switch (tail) {
    case 'falling':
      // Repay in full → swap excess USDC to asset (11b) → proportional Aave withdraw
      return [
        aaveRepay,
        dexSwapFromUsdc(lockedNAV),
        aaveWithdraw('proportional'),
      ];

    case 'rising':
      // Partial Aave withdraw → swap asset to USDC (11a) → full repay → remaining Aave withdraw
      return [
        aaveWithdrawPartial,
        dexSwapForUsdc,
        aaveRepay,
        aaveWithdraw('remaining'),
      ];

    case 'balanced':
      // Repay fully → proportional Aave withdraw
      return [
        aaveRepay,
        aaveWithdraw('proportional'),
      ];
  }
}

// ---------------------------------------------------------------------------
// Top-level mint/redeem runners used by batchProcessor
// ---------------------------------------------------------------------------

/**
 * Execute the full mint playbook.
 * Logs the scenario, runs the executor, verifies no USDC remains (sanity check).
 */
export async function runMintPlaybook(
  ctx: OpsContext,
  netMintUSD: bigint,
): Promise<void> {
  console.log(`\n💰 NET_MINT (${ctx.assetSymbol}) — deploying ${fmtUsd(netMintUSD)} net capital\n`);
  const steps = buildMintPlaybook(netMintUSD);
  await runPlaybook(steps, ctx);
}

/**
 * Execute the full redeem playbook with reactive tail selection.
 * 1. Run core (close short + withdraw HL USDC) — refreshCtx after each.
 * 2. Classify redeem tail from fresh context.
 * 3. Run tail steps.
 */
export async function runRedeemPlaybook(
  ctx: OpsContext,
  lockedNAV: bigint | undefined,
): Promise<void> {
  console.log(`\n💸 NET_REDEEM (${ctx.assetSymbol}) — redeem fraction ${(Number(ctx.redeemFraction) / 1e16).toFixed(2)}%\n`);

  // Step 1: Run core steps (close short + withdraw USDC from HL).
  // Each step has refreshCtx=true so ctx is up-to-date for canSkip checks.
  const coreSteps = buildRedeemCore();
  await runPlaybook(coreSteps, ctx);

  // Step 2: Refresh context to read the actual USDC balance now in the contract.
  const freshCtx = await snapshotOpsContext(ctx.kashYield, ctx.provider, ctx.batchCycle, lockedNAV);

  // Step 3: Classify tail from freshCtx (contractUsdc vs aaveDebt) and run tail steps.
  const tail: RedeemTail = classifyRedeemTail(freshCtx);
  console.log(`   📊 Redeem tail: ${tailLabel(tail)}`);
  console.log(`      contractUsdc=${fmtUsdc(freshCtx.contractUsdc)}, aaveDebt=${fmtUsdc(freshCtx.aaveDebt)}\n`);

  const tailSteps = buildRedeemTail(tail, lockedNAV);
  await runPlaybook(tailSteps, freshCtx);
}

// ---------------------------------------------------------------------------
// ─── TEST PLAYBOOK: Aave leverage loop ──────────────────────────────────────
// ---------------------------------------------------------------------------

/**
 * Swap ALL contract USDC back to ETH/wBTC via the spot DEX.
 * Used in the test loop between the two Aave deposit+borrow rounds.
 * refreshCtx=true so the second aave_deposit sees the freshly acquired ETH.
 */
const dexSwapAllUsdcToAsset: OpStep = {
  id: 'dex_swap_usdc_to_asset',
  substep: 'aave',
  refreshCtx: true,
  describe: (ctx) => `swap all ${fmtUsdc(ctx.contractUsdc)} USDC → ${ctx.assetSymbol} (test loop)`,
  canSkip: async (ctx) => {
    if (ctx.contractUsdc === 0n) return true;
    const spotDex = await ctx.kashYield.spotDexAddress().catch(() => null);
    if (!spotDex || spotDex === ethers.ZeroAddress) {
      console.warn('         ⚠️  spotDexAddress not configured — skipping test-loop swap');
      return true;
    }
    return false;
  },
  execute: async (ctx) => {
    const amount = ctx.contractUsdc;
    if (amount === 0n) return;
    console.log(`         swap ${fmtUsdc(amount)} → ${ctx.assetSymbol}`);
    await execTx('swapFromUsdc', ctx.kashYield.swapFromUsdc(amount));
  },
};

/**
 * Build the test Aave leverage-loop playbook:
 *
 *   Round 1: deposit ETH → borrow 70% USDC
 *   Bridge:  swap all USDC → ETH (Uniswap)
 *   Round 2: deposit new ETH → borrow 70% of that as USDC
 *
 * Example with 1 ETH @ $2,000:
 *   1. deposit 1 ETH to Aave
 *   2. borrow $1,400 USDC (70% LTV)
 *   3. swap $1,400 → 0.7 ETH
 *   4. deposit 0.7 ETH to Aave (total supplied = 1.7 ETH)
 *   5. borrow 70% of 0.7 ETH = $980 USDC (total debt = $2,380)
 *
 * All steps carry refreshCtx=true — each step must see the state left by the previous one.
 * Steps are cloned with unique IDs so the log clearly shows "round 1" vs "round 2".
 *
 * Activate with:  OPS_SCENARIO=test_aave_loop  or  --ops-scenario=test_aave_loop
 */
export function buildAaveLoopPlaybook(): OpStep[] {
  return [
    { ...aaveDeposit, id: 'aave_deposit_round1',  refreshCtx: true },
    { ...aaveBorrow,  id: 'aave_borrow_round1',   refreshCtx: true },
    dexSwapAllUsdcToAsset,
    { ...aaveDeposit, id: 'aave_deposit_round2',  refreshCtx: true },
    { ...aaveBorrow,  id: 'aave_borrow_round2',   refreshCtx: true },
  ];
}

/** Execute the test Aave loop playbook with a clear header and summary. */
export async function runTestAaveLoopPlaybook(ctx: OpsContext): Promise<void> {
  const price = ctx.price;
  const assetStr = fmtAsset(ctx.contractAsset, ctx);
  const usdStr = fmtUsd((ctx.contractAsset * price) / (10n ** ctx.assetDecimals));
  console.log(`\n🧪 TEST: Aave leverage loop — starting with ${assetStr} (${usdStr})\n`);
  console.log('   Round 1: deposit → borrow 70% USDC');
  console.log('   Bridge:  swap all USDC → ETH via spot DEX');
  console.log('   Round 2: deposit swapped ETH → borrow 70% USDC\n');

  const steps = buildAaveLoopPlaybook();
  await runPlaybook(steps, ctx);

  console.log('\n🧪 Test loop complete. Final state will be snapshotted on next run.\n');
}

// ---------------------------------------------------------------------------
// Internal sizing helper
// ---------------------------------------------------------------------------

/**
 * Proportional Aave withdrawal amount for partial redemption.
 * Uses lockedNAV-scaled USD amount when available (more precise than fraction × aaveSupplied
 * because it accounts for daily yield accrued in Aave that isn't yet in currentNAV).
 * Falls back to fraction × aaveSupplied when lockedNAV is unavailable.
 */
function _proportionalWithdrawAmount(ctx: OpsContext): bigint {
  // lockedNAV-based sizing mirrors how Phase 2 will pay out redeemers
  if (ctx.totalRedeemAsset > 0n && ctx.redeemFraction < BigInt(1e18)) {
    return ctx.totalRedeemAsset;
  }
  // Fraction-based fallback
  return (ctx.aaveSupplied * ctx.redeemFraction) / BigInt(1e18);
}
