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

const HL_ACTION_IFACE = new ethers.Interface([
  'function openShort(string symbol, uint256 size)',
  'function closeShort(string symbol)',
  'function closeShort(string symbol, uint256 closeSize)',
  'function spotBuyOnHyperliquid(uint256 usdcAmount)',
  'function spotSellOnHyperliquid(uint256 amount)',
]);

type HlIntent =
  | 'EXCHANGE_OPEN_SHORT'
  | 'EXCHANGE_CLOSE_SHORT'
  | 'EXCHANGE_SPOT_BUY'
  | 'EXCHANGE_SPOT_SELL';

function hlUserAddress(ctx: OpsContext): string {
  if (ctx.hlDirectDepositMode) return ctx.hlAccountAddress || '';
  return ctx.perpAdapterAddress || '';
}

function relayStrictMode(): boolean {
  return (process.env.HL_EVENT_RELAY_STRICT || 'false').toLowerCase() === 'true';
}

function isRelayEnabled(ctx: OpsContext): boolean {
  if (!ctx.hlEventRelayEnabled) return false;
  const ex = (ctx.activePerpExchange || '').toUpperCase();
  // Accept both canonical "HL" and descriptive names like "HYPERLIQUID".
  return ex === 'HL' || ex === 'HYPERLIQUID';
}

function fmtUsdc(v: bigint): string { return ethers.formatUnits(v, 6) + ' USDC'; }
function fmtAsset(v: bigint, ctx: OpsContext): string {
  return ethers.formatUnits(v, Number(ctx.assetDecimals)) + ' ' + ctx.assetSymbol;
}
function fmtUsd(v: bigint): string { return '$' + ethers.formatEther(v); }

function getHlWithdrawFeeToleranceUsdc6(): bigint {
  const raw = process.env.HL_WITHDRAW_FEE_TOLERANCE_USDC || '1';
  try {
    const parsed = ethers.parseUnits(raw, 6);
    return parsed >= 0n ? parsed : 0n;
  } catch {
    return 1_000_000n; // 1 USDC default fallback
  }
}

async function getAaveAvailableBorrowUsdc6(ctx: OpsContext): Promise<bigint> {
  if (!ctx.aavePoolAddress || ctx.aavePoolAddress === ethers.ZeroAddress) return 0n;
  try {
    const pool = new ethers.Contract(
      ctx.aavePoolAddress,
      ['function getUserAccountData(address) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)'],
      ctx.provider,
    );
    const userAddr = config.aaveUserAddress || (config.kashYieldAddress || await ctx.kashYield.getAddress());
    const data = await pool.getUserAccountData(userAddr);
    const availableBase8 = BigInt(data.availableBorrowsBase.toString()); // USD with 8 decimals
    // USD(8) -> USDC(6)
    const availableUsdc6 = availableBase8 / 100n;
    // Keep a tiny safety buffer (0.05 USDC) to avoid edge reverts between read and tx.
    return availableUsdc6 > 50_000n ? availableUsdc6 - 50_000n : 0n;
  } catch {
    return 0n;
  }
}

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
    return `borrow up to ${ltvPct}% LTV — target delta ${fmtUsdc(toBorrow)}`;
  },
  canSkip: async (ctx) => {
    const ltv = BigInt(config.strategy.borrowLtvPct);
    const suppliedUSD = ctx.isBtc
      ? (ctx.aaveSupplied * ctx.price) / (10n ** 8n)
      : (ctx.aaveSupplied * ctx.price) / (10n ** 18n);
    const targetUsdc6 = (suppliedUSD * ltv) / 100n / (10n ** 12n);
    if (ctx.aaveDebt >= targetUsdc6) return true;
    const desiredDelta = targetUsdc6 - ctx.aaveDebt;
    const availableDelta = await getAaveAvailableBorrowUsdc6(ctx);
    return availableDelta === 0n || desiredDelta === 0n;
  },
  execute: async (ctx) => {
    const ltv = BigInt(config.strategy.borrowLtvPct);
    const suppliedUSD = ctx.isBtc
      ? (ctx.aaveSupplied * ctx.price) / (10n ** 8n)
      : (ctx.aaveSupplied * ctx.price) / (10n ** 18n);
    const targetUsdc6 = (suppliedUSD * ltv) / 100n / (10n ** 12n);
    const desiredDelta = targetUsdc6 > ctx.aaveDebt ? targetUsdc6 - ctx.aaveDebt : 0n;
    const availableDelta = await getAaveAvailableBorrowUsdc6(ctx);
    const toBorrow = desiredDelta < availableDelta ? desiredDelta : availableDelta;
    if (toBorrow === 0n) return;
    if (toBorrow < desiredDelta) {
      console.warn(`         ⚠️  Capping borrow to Aave available headroom: requested ${fmtUsdc(desiredDelta)}, borrowing ${fmtUsdc(toBorrow)}`);
    } else {
      console.log(`         ${fmtUsdc(toBorrow)}`);
    }
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
    if (ctx.hlDirectDepositMode) {
      await maybeBridgeDirectModeDepositToHl(ctx, amount);
    }
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
    const tx = await ctx.kashYield.openShort(symbol, size);
    await tx.wait();
    console.log('      → openShort confirmed');
    try {
      await maybeRunHlEventRelay(ctx, tx.hash, 'EXCHANGE_OPEN_SHORT');
    } catch (e: any) {
      if (relayStrictMode()) throw e;
      console.warn(`      ⚠️  HL relay openShort failed: ${e?.message ?? e}`);
    }
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
      const tx = await ctx.kashYield['closeShort(string)'](symbol);
      await tx.wait();
      console.log('      → closeShort(full) confirmed');
      try {
        await maybeRunHlEventRelay(ctx, tx.hash, 'EXCHANGE_CLOSE_SHORT');
      } catch (e: any) {
        if (relayStrictMode()) throw e;
        console.warn(`      ⚠️  HL relay closeShort failed: ${e?.message ?? e}`);
      }
    } else {
      console.log(`         closing ${fmtAsset(closeSize, ctx)} of ${fmtAsset(fullSize, ctx)}`);
      const tx = await ctx.kashYield['closeShort(string,uint256)'](symbol, closeSize);
      await tx.wait();
      console.log('      → closeShort(partial) confirmed');
      try {
        await maybeRunHlEventRelay(ctx, tx.hash, 'EXCHANGE_CLOSE_SHORT');
      } catch (e: any) {
        if (relayStrictMode()) throw e;
        console.warn(`      ⚠️  HL relay closeShort failed: ${e?.message ?? e}`);
      }
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
    const contractAddr = config.kashYieldAddress || await ctx.kashYield.getAddress();
    if (!ctx.usdcAddress || ctx.usdcAddress === ethers.ZeroAddress) {
      throw new Error('Strict HL withdraw check requires usdcAddress on KashYield.');
    }

    const usdc = new ethers.Contract(ctx.usdcAddress, ['function balanceOf(address) view returns (uint256)'], ctx.provider);
    const beforeUsdc = BigInt((await usdc.balanceOf(contractAddr)).toString());
    await execTx('withdrawFromHyperliquid', ctx.kashYield.withdrawFromHyperliquid(amount));
    const afterUsdc = BigInt((await usdc.balanceOf(contractAddr)).toString());
    const received = afterUsdc > beforeUsdc ? afterUsdc - beforeUsdc : 0n;
    const feeTolerance = getHlWithdrawFeeToleranceUsdc6();

    console.log(`         received on contract: ${fmtUsdc(received)} (before=${fmtUsdc(beforeUsdc)} → after=${fmtUsdc(afterUsdc)})`);
    if (received + feeTolerance < amount) {
      console.warn(
        `         ⚠️  HL withdraw not fully settled yet: expected ${fmtUsdc(amount)} (tolerance ${fmtUsdc(feeTolerance)}), ` +
        `received ${fmtUsdc(received)}. Waiting/retry logic will run before tail classification.`
      );
    } else if (received < amount) {
      const impliedFee = amount - received;
      console.log(`         fee/slippage accounted: ${fmtUsdc(impliedFee)} (tolerance ${fmtUsdc(feeTolerance)})`);
    }
  },
};

// ---------------------------------------------------------------------------
// ─── REDEEM TAIL STEPS (falling / rising / balanced) ────────────────────────
// ---------------------------------------------------------------------------

/** 09 — Repay Aave borrow with all available contract USDC */
const aaveRepay: OpStep = {
  id: 'aave_repay',
  substep: 'aave',
  refreshCtx: true,
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
  refreshCtx: true,
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
  refreshCtx: true,
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
  refreshCtx: true,
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

async function maybeBridgeDirectModeDepositToHl(ctx: OpsContext, amountUsdc6: bigint): Promise<void> {
  if (!ctx.hlDirectDepositMode || amountUsdc6 === 0n) return;
  if (!ctx.hlBridgeAddress || ctx.hlBridgeAddress === ethers.ZeroAddress) {
    throw new Error('HL direct mode is enabled but adapter hlBridgeAddress is not set');
  }
  const signerPk = process.env.HYPERLIQUID_API_PRIVATE_KEY || config.privateKey;
  if (!signerPk) throw new Error('HL direct mode requires HYPERLIQUID_API_PRIVATE_KEY (or PRIVATE_KEY)');

  const signer = new ethers.Wallet(signerPk, ctx.provider);
  if (ctx.hlAccountAddress && ctx.hlAccountAddress !== ethers.ZeroAddress) {
    if (signer.address.toLowerCase() !== ctx.hlAccountAddress.toLowerCase()) {
      throw new Error(
        `HL direct mode requires signer=${ctx.hlAccountAddress}; got ${signer.address}. ` +
        'Set HYPERLIQUID_API_PRIVATE_KEY to the hlAccount key.'
      );
    }
  }

  const usdc = new ethers.Contract(
    ctx.usdcAddress,
    ['function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)'],
    signer,
  );
  const bal = BigInt((await usdc.balanceOf(signer.address)).toString());
  if (bal < amountUsdc6) {
    throw new Error(`HL direct mode bridge transfer failed: signer has ${fmtUsdc(bal)} but needs ${fmtUsdc(amountUsdc6)}`);
  }

  console.log(`      ↪ direct mode: bridge ${fmtUsdc(amountUsdc6)} from hlAccount ${signer.address} → ${ctx.hlBridgeAddress}`);
  const tx = await usdc.transfer(ctx.hlBridgeAddress, amountUsdc6);
  await tx.wait();
  console.log('      → hlBridge USDC transfer confirmed');
}

function trimDec(v: string, maxDp = 6): string {
  const [whole, frac = ''] = v.split('.');
  if (!frac) return whole;
  const cut = frac.slice(0, maxDp).replace(/0+$/, '');
  return cut ? `${whole}.${cut}` : whole;
}

function formatHlSize(sizeRaw: string, szDecimals: number): string {
  const [whole, frac = ''] = String(sizeRaw).split('.');
  if (szDecimals <= 0) return whole;
  const cut = frac.slice(0, szDecimals).replace(/0+$/, '');
  return cut ? `${whole}.${cut}` : whole;
}

function limitPx(midRaw: unknown, isBuy: boolean): string {
  const mid = Number(midRaw ?? 0);
  if (!Number.isFinite(mid) || mid <= 0) return '0';
  const px = isBuy ? mid * 1.03 : mid * 0.97;
  return trimDec(String(px), 6);
}

function formatHlLimitPx(midRaw: unknown, isBuy: boolean, szDecimals = 0): string {
  const mid = Number(midRaw ?? 0);
  if (!Number.isFinite(mid) || mid <= 0) return '0';
  const raw = isBuy ? mid * 1.03 : mid * 0.97;
  // HL price precision constraints:
  // - max 5 significant figures
  // - max decimals = 6 - szDecimals
  const maxDecimals = Math.max(0, 6 - Number(szDecimals || 0));
  const sigRounded = Number(raw.toPrecision(5));
  const decRounded = Number(sigRounded.toFixed(maxDecimals));
  return trimDec(String(decRounded), maxDecimals);
}

function findPerpAssetId(meta: any, symbol: string): number {
  const target = symbol.toUpperCase();
  const idx = (meta?.universe || []).findIndex((u: any) => String(u?.name || '').toUpperCase() === target);
  if (idx < 0) throw new Error(`HL perp symbol not found in meta universe: ${symbol}`);
  return idx;
}

function resolveSpotPairName(spotMeta: any, symbol: string): string {
  const explicit = process.env.HL_SPOT_PAIR_NAME;
  if (explicit) return explicit;
  const target = `${symbol.toUpperCase()}/USDC`;
  const match = (spotMeta?.universe || []).find((u: any) => String(u?.name || '').toUpperCase() === target);
  if (!match) throw new Error(`HL spot pair not found: ${target}. Set HL_SPOT_PAIR_NAME or HL_SPOT_ASSET_ID.`);
  return String(match.name);
}

function resolveSpotAssetId(spotMeta: any, pairName: string): number {
  if (process.env.HL_SPOT_ASSET_ID) return parseInt(process.env.HL_SPOT_ASSET_ID, 10);
  const match = (spotMeta?.universe || []).find((u: any) => String(u?.name || '') === pairName);
  if (!match) throw new Error(`could not resolve spot pair index for ${pairName}`);
  return 10000 + Number(match.index);
}

function findSpotBalance(spotState: any, coin: string): string {
  const bal = (spotState?.balances || []).find((b: any) =>
    String(b?.coin || '').toUpperCase() === coin.toUpperCase()
  );
  return String(bal?.total || '0');
}

function findPosition(clearinghouseState: any, symbol: string): any {
  return (clearinghouseState?.assetPositions || []).find((p: any) =>
    String(p?.position?.coin || '').toUpperCase() === symbol.toUpperCase()
  );
}

function decimalToBigInt(value: unknown, decimals: number): bigint {
  const s = String(value ?? '0').trim();
  if (!s || s === '0') return 0n;
  const neg = s.startsWith('-');
  const clean = neg ? s.slice(1) : s;
  const [intPartRaw, fracRaw = ''] = clean.split('.');
  const intPart = intPartRaw || '0';
  const fracPadded = (fracRaw + '0'.repeat(decimals)).slice(0, decimals);
  const combined = `${intPart}${fracPadded}`.replace(/^0+/, '') || '0';
  const v = BigInt(combined);
  return neg ? -v : v;
}

function absDecimal(value: unknown): string {
  const s = String(value || '0');
  return s.startsWith('-') ? s.slice(1) : s;
}

function selectUsdcForSync(spotUsdcStr: string, withdrawableStr: string): string {
  // For redemption we need the amount that can be bridged out now.
  // HL can report usable collateral in `withdrawable` while spot USDC is lower.
  const spot6 = decimalToBigInt(spotUsdcStr || '0', 6);
  const wd6 = decimalToBigInt(withdrawableStr || '0', 6);
  return wd6 > spot6 ? withdrawableStr : spotUsdcStr;
}

async function maybeRunHlEventRelay(ctx: OpsContext, txHash: string, expected: HlIntent): Promise<void> {
  if (!isRelayEnabled(ctx)) return;
  const signerPk = process.env.HYPERLIQUID_API_PRIVATE_KEY || config.privateKey;
  if (!signerPk) {
    const msg = `${expected}: missing HYPERLIQUID_API_PRIVATE_KEY (or PRIVATE_KEY) for HL relay`;
    if (relayStrictMode()) throw new Error(msg);
    console.warn(`      ⚠️  ${msg}`);
    return;
  }

  const hlUser = hlUserAddress(ctx);
  if (!hlUser || hlUser === ethers.ZeroAddress) {
    const msg = `${expected}: unable to resolve HL user address`;
    if (relayStrictMode()) throw new Error(msg);
    console.warn(`      ⚠️  ${msg}`);
    return;
  }

  const tx = await ctx.provider.getTransaction(txHash);
  if (!tx) throw new Error(`tx not found: ${txHash}`);
  const parsed = HL_ACTION_IFACE.parseTransaction({ data: tx.data, value: tx.value });
  if (!parsed) throw new Error(`could not decode tx calldata for ${txHash}`);

  const { ExchangeClient, InfoClient, HttpTransport } = await import('@nktkas/hyperliquid');
  const hlApiUrl = (process.env.HYPERLIQUID_API_URL || 'https://api.hyperliquid.xyz').replace(/\/+$/, '');
  const wallet = new ethers.Wallet(signerPk);
  const sharedTransport = new HttpTransport({ apiUrl: hlApiUrl });
  const info = new InfoClient({ transport: sharedTransport });
  const exchange = new ExchangeClient({
    transport: sharedTransport,
    wallet,
    signatureChainId: '0xa4b1',
  });
  const orderOpts = wallet.address.toLowerCase() === hlUser.toLowerCase()
    ? undefined
    : { vaultAddress: hlUser };

  const perpMeta = await info.meta();
  const mids = await info.allMids();

  if (expected === 'EXCHANGE_OPEN_SHORT') {
    const symbol = String(parsed.args[0]).toUpperCase();
    const assetId = findPerpAssetId(perpMeta, symbol);
    const szDecimals = Number(perpMeta?.universe?.[assetId]?.szDecimals ?? 0);
    const rawSize = ethers.formatUnits(BigInt(parsed.args[1].toString()), Number(ctx.assetDecimals));
    const size = formatHlSize(rawSize, szDecimals);
    if (!size || size === '0') throw new Error(`computed HL order size is 0 after szDecimals=${szDecimals} rounding`);
    const px = formatHlLimitPx(mids[symbol], false, szDecimals);
    console.log(`      ↪ HL relay: SELL ${size} ${symbol} @ IOC ${px}`);
    await exchange.order({
      orders: [{ a: assetId, b: false, p: px, s: size, r: false, t: { limit: { tif: 'Ioc' } } }],
      grouping: 'na',
    }, orderOpts as any);
  } else if (expected === 'EXCHANGE_CLOSE_SHORT') {
    const symbol = String(parsed.args[0]).toUpperCase();
    let closeSize18 = 0n;
    if (parsed.name === 'closeShort' && parsed.args.length > 1) {
      closeSize18 = BigInt(parsed.args[1].toString());
    } else {
      const chState: any = await info.clearinghouseState({ user: hlUser });
      const pos = (chState?.assetPositions || []).find((p: any) =>
        String(p?.position?.coin || '').toUpperCase() === symbol
      );
      if (pos) closeSize18 = ethers.parseUnits(String(pos.position.szi).replace('-', ''), Number(ctx.assetDecimals));
    }
    if (closeSize18 > 0n) {
      const assetId = findPerpAssetId(perpMeta, symbol);
      const szDecimals = Number(perpMeta?.universe?.[assetId]?.szDecimals ?? 0);
      const rawSize = ethers.formatUnits(closeSize18, Number(ctx.assetDecimals));
      const size = formatHlSize(rawSize, szDecimals);
      if (!size || size === '0') {
        console.log(`      ↪ HL relay: close size rounds to 0 at szDecimals=${szDecimals}; skipping close order`);
        return;
      }
      const px = formatHlLimitPx(mids[symbol], true, szDecimals);
      console.log(`      ↪ HL relay: BUY ${size} ${symbol} reduce-only @ IOC ${px}`);
      await exchange.order({
        orders: [{ a: assetId, b: true, p: px, s: size, r: true, t: { limit: { tif: 'Ioc' } } }],
        grouping: 'na',
      }, orderOpts as any);
    }
  } else if (expected === 'EXCHANGE_SPOT_BUY') {
    const symbol = ctx.assetSymbol.toUpperCase();
    const usdcAmount6 = BigInt(parsed.args[0].toString());
    const spotMeta = await info.spotMeta();
    const pair = resolveSpotPairName(spotMeta, symbol);
    const spotAssetId = resolveSpotAssetId(spotMeta, pair);
    const mid = mids[pair] ?? mids[symbol];
    const mid18 = ethers.parseUnits(String(mid || '0'), 18);
    if (mid18 <= 0n) throw new Error(`invalid HL mid for ${pair}`);
    const sizeWei = (usdcAmount6 * (10n ** 30n)) / mid18;
    const size = trimDec(ethers.formatUnits(sizeWei, Number(ctx.assetDecimals)));
    const px = limitPx(mid, true);
    console.log(`      ↪ HL relay: SPOT BUY ${size} ${pair} @ IOC ${px}`);
    await exchange.order({
      orders: [{ a: spotAssetId, b: true, p: px, s: size, r: false, t: { limit: { tif: 'Ioc' } } }],
      grouping: 'na',
    }, orderOpts as any);
  } else if (expected === 'EXCHANGE_SPOT_SELL') {
    const symbol = ctx.assetSymbol.toUpperCase();
    const amount = BigInt(parsed.args[0].toString());
    const spotMeta = await info.spotMeta();
    const pair = resolveSpotPairName(spotMeta, symbol);
    const spotAssetId = resolveSpotAssetId(spotMeta, pair);
    const size = trimDec(ethers.formatUnits(amount, Number(ctx.assetDecimals)));
    const px = limitPx(mids[pair] ?? mids[symbol], false);
    console.log(`      ↪ HL relay: SPOT SELL ${size} ${pair} @ IOC ${px}`);
    await exchange.order({
      orders: [{ a: spotAssetId, b: false, p: px, s: size, r: false, t: { limit: { tif: 'Ioc' } } }],
      grouping: 'na',
    }, orderOpts as any);
  }

  if (ctx.perpAdapterAddress && ctx.perpAdapterAddress !== ethers.ZeroAddress) {
    const signer = new ethers.Wallet(config.privateKey || signerPk, ctx.provider);
    const adapter = new ethers.Contract(
      ctx.perpAdapterAddress,
      [
        'function syncBalances(uint256 newUsdcBalance, uint256 newAssetBalance) external',
        'function syncPosition(string symbol, uint256 size, uint256 entryPrice, bool isActive) external',
      ],
      signer,
    );

    const ch = await info.clearinghouseState({ user: hlUser });
    const spot = await info.spotClearinghouseState({ user: hlUser }).catch(() => ({ balances: [] }));
    const usdcSpotStr = findSpotBalance(spot, 'USDC');
    const withdrawableStr = String(ch?.withdrawable || '0');
    const usdcStr = selectUsdcForSync(usdcSpotStr, withdrawableStr);
    const assetStr = findSpotBalance(spot, ctx.assetSymbol);
    const pos = findPosition(ch, ctx.assetSymbol);

    const usdc6 = decimalToBigInt(usdcStr, 6);
    const asset18 = decimalToBigInt(assetStr || '0', 18);
    const size18 = decimalToBigInt(absDecimal(pos?.position?.szi || '0'), 18);
    const entry18 = decimalToBigInt(pos?.position?.entryPx || '0', 18);
    const isActive = size18 > 0n;

    await (await adapter.syncBalances(usdc6, asset18)).wait();
    await (await adapter.syncPosition(ctx.assetSymbol, size18, entry18, isActive)).wait();
    console.log('      → HL adapter syncBalances + syncPosition confirmed');
  }
}

async function maybeInitiateHlOffchainWithdraw(ctx: OpsContext, amountUsdc6: bigint): Promise<void> {
  if (amountUsdc6 <= 0n) return;
  const signerPk = process.env.HYPERLIQUID_API_PRIVATE_KEY || config.privateKey;
  if (!signerPk) throw new Error('Missing HYPERLIQUID_API_PRIVATE_KEY (or PRIVATE_KEY) for HL withdraw3');
  const hlUser = hlUserAddress(ctx);
  if (!hlUser || hlUser === ethers.ZeroAddress) throw new Error('Unable to resolve HL user for withdraw3');

  const destination = (ctx.perpAdapterAddress && ctx.perpAdapterAddress !== ethers.ZeroAddress)
    ? ctx.perpAdapterAddress
    : (config.kashYieldAddress || await ctx.kashYield.getAddress());
  const amountStr = trimDec(ethers.formatUnits(amountUsdc6, 6), 6);
  if (!amountStr || Number(amountStr) <= 0) return;

  const { ExchangeClient, HttpTransport } = await import('@nktkas/hyperliquid');
  const hlApiUrl = (process.env.HYPERLIQUID_API_URL || 'https://api.hyperliquid.xyz').replace(/\/+$/, '');
  const wallet = new ethers.Wallet(signerPk);
  const exchange = new ExchangeClient({
    transport: new HttpTransport({ apiUrl: hlApiUrl }),
    wallet,
    signatureChainId: '0xa4b1',
  });

  const opts = wallet.address.toLowerCase() === hlUser.toLowerCase()
    ? undefined
    : ({ vaultAddress: hlUser } as any);

  console.log(`      ↪ HL API withdraw3: amount=${amountStr} USDC, destination=${destination}`);
  await exchange.withdraw3({ destination, amount: amountStr }, opts);
}

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
  let freshCtx = await snapshotOpsContext(ctx.kashYield, ctx.provider, ctx.batchCycle, lockedNAV);
  freshCtx = await waitForHlWithdrawSettlementIfNeeded(freshCtx, lockedNAV);

  // Step 3: Classify tail from freshCtx (contractUsdc vs aaveDebt) and run tail steps.
  const tail: RedeemTail = classifyRedeemTail(freshCtx);
  console.log(`   📊 Redeem tail: ${tailLabel(tail)}`);
  console.log(`      contractUsdc=${fmtUsdc(freshCtx.contractUsdc)}, aaveDebt=${fmtUsdc(freshCtx.aaveDebt)}\n`);

  const tailSteps = buildRedeemTail(tail, lockedNAV);
  await runPlaybook(tailSteps, freshCtx);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHlWithdrawSettlementIfNeeded(
  ctx: OpsContext,
  lockedNAV: bigint | undefined,
): Promise<OpsContext> {
  const enabled = (process.env.HL_WITHDRAW_WAIT_ENABLED || 'true').toLowerCase() !== 'false';
  if (!enabled) return ctx;
  if (ctx.aaveDebt === 0n || ctx.contractUsdc >= ctx.aaveDebt) return ctx;
  const feeTolerance = getHlWithdrawFeeToleranceUsdc6();

  const maxMs = Math.max(0, parseInt(process.env.HL_WITHDRAW_WAIT_MAX_MS || '360000', 10)); // default 6 min
  const pollMs = Math.max(1000, parseInt(process.env.HL_WITHDRAW_WAIT_POLL_MS || '20000', 10)); // default 20s
  if (maxMs === 0) return ctx;

  console.log(
    `   ⏳ Waiting for HL withdrawal settlement (up to ${(maxMs / 1000).toFixed(0)}s, poll ${(pollMs / 1000).toFixed(0)}s)` +
    ` — debt=${fmtUsdc(ctx.aaveDebt)}, contractUsdc=${fmtUsdc(ctx.contractUsdc)}`
  );

  const started = Date.now();
  let attempts = 0;
  let withdrawInitiated = false;
  let fresh = ctx;
  while (Date.now() - started < maxMs) {
    const debtRemaining = fresh.aaveDebt > fresh.contractUsdc ? fresh.aaveDebt - fresh.contractUsdc : 0n;
    if (debtRemaining <= feeTolerance) break;

    if (!withdrawInitiated && fresh.hlUsdcBalance > 0n) {
      try {
        const requestAmt = fresh.hlUsdcBalance < debtRemaining ? fresh.hlUsdcBalance : debtRemaining;
        await maybeInitiateHlOffchainWithdraw(fresh, requestAmt);
        withdrawInitiated = true;
      } catch (e: any) {
        console.warn(`      ⚠️  HL off-chain withdraw initiation failed: ${e?.message ?? e}`);
      }
    }

    // Retry pull from adapter if HL-reported USDC is available.
    if (fresh.hlUsdcBalance > 0n) {
      const toPull = fresh.hlUsdcBalance < debtRemaining ? fresh.hlUsdcBalance : debtRemaining;
      if (toPull > 0n) {
        attempts++;
        console.log(`      ↪ settlement retry #${attempts}: withdraw ${fmtUsdc(toPull)} from HL`);
        try {
          await execTx(`withdrawFromHyperliquid(retry#${attempts})`, fresh.kashYield.withdrawFromHyperliquid(toPull));
        } catch (e: any) {
          console.warn(`      ⚠️  settlement retry #${attempts} failed: ${e?.message ?? e}`);
        }
      }
    }

    await sleep(pollMs);
    fresh = await snapshotOpsContext(fresh.kashYield, fresh.provider, fresh.batchCycle, lockedNAV);
    console.log(`      ↪ settlement status: contractUsdc=${fmtUsdc(fresh.contractUsdc)}, aaveDebt=${fmtUsdc(fresh.aaveDebt)}, hlUsdc=${fmtUsdc(fresh.hlUsdcBalance)}`);
    const shortfallNow = fresh.aaveDebt > fresh.contractUsdc ? fresh.aaveDebt - fresh.contractUsdc : 0n;
    if (shortfallNow <= feeTolerance) break;
  }

  const finalShortfall = fresh.aaveDebt > fresh.contractUsdc ? fresh.aaveDebt - fresh.contractUsdc : 0n;
  if (finalShortfall > feeTolerance) {
    const missing = fresh.aaveDebt - fresh.contractUsdc;
    throw new Error(
      `HL withdraw settlement incomplete: contract USDC ${fmtUsdc(fresh.contractUsdc)} < Aave debt ${fmtUsdc(fresh.aaveDebt)} ` +
      `(shortfall ${fmtUsdc(missing)}). Stopping before tail classification; wait for HL USDC to arrive, then re-run ops.`
    );
  } else {
    if (finalShortfall > 0n) {
      console.log(`   ✅ HL settlement wait complete within fee tolerance: shortfall=${fmtUsdc(finalShortfall)} (tolerance ${fmtUsdc(feeTolerance)})`);
    } else {
      console.log('   ✅ HL settlement wait complete: contract USDC now covers Aave debt');
    }
  }

  return fresh;
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
 * WHY a simplified canSkip for deposit steps:
 * The default aave_deposit.canSkip checks `aaveSupplied >= contractAsset × depositPct`.
 * After round 1 deposits 1 ETH, aaveSupplied = 1 ETH. After the bridge swap, contractAsset = 0.7 ETH.
 * The default check would see `1 ETH >= 0.7 ETH` → skip — round 2 never deposits.
 * The loop-specific canSkip only checks whether there is new asset in the contract to deposit.
 *
 * Activate with:  OPS_SCENARIO=test_aave_loop  or  --ops-scenario=test_aave_loop
 */
export function buildAaveLoopPlaybook(): OpStep[] {
  // Loop deposit: only skip when there is literally nothing in the contract to deposit.
  const depositForLoop = (id: string): OpStep => ({
    ...aaveDeposit,
    id,
    refreshCtx: true,
    canSkip: async (ctx) => ctx.contractAsset === 0n,
  });

  return [
    depositForLoop('aave_deposit_round1'),
    { ...aaveBorrow, id: 'aave_borrow_round1', refreshCtx: true },
    dexSwapAllUsdcToAsset,
    depositForLoop('aave_deposit_round2'),
    { ...aaveBorrow, id: 'aave_borrow_round2', refreshCtx: true },
  ];
}

/** Execute the test Aave loop playbook with a clear header and summary. */
export async function runTestAaveLoopPlaybook(ctx: OpsContext): Promise<void> {
  const price = ctx.price;
  const assetStr = fmtAsset(ctx.contractAsset, ctx);
  const usdStr = fmtUsd((ctx.contractAsset * price) / (10n ** ctx.assetDecimals));
  const ltv = config.strategy.borrowLtvPct;
  const round1BorrowUsdc = (ctx.contractAsset * price * BigInt(ltv)) / (100n * (10n ** ctx.assetDecimals) * (10n ** 12n));
  const round1SwapEth = (round1BorrowUsdc * (10n ** 12n) * (10n ** ctx.assetDecimals)) / price;
  const round2BorrowUsdc = (round1SwapEth * price * BigInt(ltv)) / (100n * (10n ** ctx.assetDecimals) * (10n ** 12n));

  console.log(`\n🧪 TEST: Aave leverage loop — starting with ${assetStr} (${usdStr})\n`);
  console.log(`   Round 1: deposit ${assetStr} → borrow ${ltv}% LTV = ~${fmtUsdc(round1BorrowUsdc)}`);
  console.log(`   Bridge:  swap ~${fmtUsdc(round1BorrowUsdc)} → ~${fmtAsset(round1SwapEth, ctx)}`);
  console.log(`   Round 2: deposit ~${fmtAsset(round1SwapEth, ctx)} → borrow ${ltv}% = ~${fmtUsdc(round2BorrowUsdc)}`);

  if (config.dryRunOps) {
    console.log('\n   ⚠️  Dry-run note: step descriptions below use the initial snapshot.');
    console.log('      Steps 2-5 show stale USDC/ETH amounts because each step refreshes');
    console.log('      context at execution time. The estimates above (this header) are accurate.\n');
  } else {
    console.log();
  }

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
