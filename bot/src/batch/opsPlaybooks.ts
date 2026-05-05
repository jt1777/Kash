import { ethers } from 'ethers';
import { config } from '../config';
import {
  snapshotOpsContext,
  computeTotalRedeemAsset,
  readHyperliquidAdapterAddress,
  type OpsContext,
} from './opsContext';
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
      const nextCtx = await snapshotOpsContext(ctx.kashYield, ctx.provider, ctx.batchCycle, ctx.lockedNAV);
      nextCtx.aaveDebtFloor = ctx.aaveDebtFloor;
      ctx = nextCtx;
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

async function execTx(
  label: string,
  txPromise: Promise<ethers.ContractTransactionResponse>,
): Promise<ethers.ContractTransactionReceipt | null> {
  const tx = await txPromise;
  const receipt = await tx.wait();
  console.log(`      → ${label} confirmed`);
  return receipt;
}

/**
 * `withdrawFromHyperliquid(requested)` then log **KashYield USDC delta** (actual bridge-in),
 * not only the requested amount. Optionally logs adapter ERC-20 USDC delta.
 */
async function execHlWithdrawToKashYield(
  ctx: OpsContext,
  logLabel: string,
  amountRequested: bigint,
): Promise<{ received: bigint }> {
  const contractAddr = config.kashYieldAddress || (await ctx.kashYield.getAddress());
  if (!ctx.usdcAddress || ctx.usdcAddress === ethers.ZeroAddress) {
    throw new Error('Strict HL withdraw check requires usdcAddress on KashYield.');
  }
  const usdc = new ethers.Contract(ctx.usdcAddress, ['function balanceOf(address) view returns (uint256)'], ctx.provider);
  const beforeKy = BigInt((await usdc.balanceOf(contractAddr)).toString());
  let beforeAd = 0n;
  const ad = ctx.perpAdapterAddress;
  if (ad) beforeAd = BigInt((await usdc.balanceOf(ad)).toString());

  const tx = await ctx.kashYield.withdrawFromHyperliquid(amountRequested);
  await tx.wait();
  console.log(`      → ${logLabel} confirmed`);

  const afterKy = BigInt((await usdc.balanceOf(contractAddr)).toString());
  const received = afterKy > beforeKy ? afterKy - beforeKy : 0n;
  let adapterNote = '';
  if (ad) {
    const afterAd = BigInt((await usdc.balanceOf(ad)).toString());
    const deltaAd = beforeAd > afterAd ? beforeAd - afterAd : 0n;
    adapterNote = `; adapter USDC −${fmtUsdc(deltaAd)}`;
  }
  console.log(
    `         (${logLabel}: requested ${fmtUsdc(amountRequested)} → KashYield +${fmtUsdc(received)}${adapterNote})`,
  );
  if (received === 0n) {
    console.warn(
      '         ⚠️  HL withdraw tx confirmed, but 0 USDC received on KashYield (bridged USDC likely not settled on Arbitrum yet).',
    );
  }
  return { received };
}

/** Optional gasLimit for spot swaps — avoids RPC estimateGas preflight when set (real Uniswap still executes on-chain). */
function swapTxOverrides(): { gasLimit?: bigint } {
  const raw = process.env.OPS_SWAP_GAS_LIMIT?.trim();
  if (!raw) return {};
  try {
    const n = BigInt(raw);
    return n > 0n ? { gasLimit: n } : {};
  } catch {
    return {};
  }
}

/** Real Aave V3 calls can be under-estimated on Arbitrum; use a modest default buffer. */
function aaveTxOverrides(): { gasLimit?: bigint } {
  const raw = (process.env.OPS_AAVE_GAS_LIMIT || '500000').trim();
  try {
    const n = BigInt(raw);
    return n > 0n ? { gasLimit: n } : {};
  } catch {
    return { gasLimit: 500000n };
  }
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

function hlOpenShortWaitMaxMs(): number {
  return Math.max(0, parseInt(process.env.HL_OPEN_SHORT_WAIT_MAX_MS || '180000', 10));
}

function hlOpenShortWaitPollMs(): number {
  return Math.max(1000, parseInt(process.env.HL_OPEN_SHORT_WAIT_POLL_MS || '10000', 10));
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
/** HL perp sizes on the adapter / in closeShort(uint256) are always 18-dec (not token decimals). */
const HL_PERP_SIZE_DECIMALS = 18;
function fmtHlPerpSize(v: bigint, ctx: OpsContext): string {
  return ethers.formatUnits(v, HL_PERP_SIZE_DECIMALS) + ' ' + ctx.assetSymbol;
}
function fmtUsd(v: bigint): string { return '$' + ethers.formatEther(v); }
const WAD = 10n ** 18n;

function getHlWithdrawFeeToleranceUsdc6(): bigint {
  const raw = process.env.HL_WITHDRAW_FEE_TOLERANCE_USDC || '1';
  try {
    const parsed = ethers.parseUnits(raw, 6);
    return parsed >= 0n ? parsed : 0n;
  } catch {
    return 1_000_000n; // 1 USDC default fallback
  }
}

/** All deployable USDC on KashYield (`ctx.contractUsdc`, already net of `ownerUsdcReserve`) may be swapped in 11b. */
function falling11bSpendableUsdc(ctx: OpsContext): bigint {
  return ctx.contractUsdc;
}

/** 11b swap USDC (6 dec): `usdcNeeded` to cover the wBTC/ETH gap vs `totalRedeemAsset`, capped by deployable USDC. If the vault already has enough asset, returns 0 so USDC is not swapped to asset. */
function computeFalling11bUsdcToSwap(ctx: OpsContext): bigint {
  const spendable = falling11bSpendableUsdc(ctx);
  if (spendable === 0n) return 0n;
  const assetNeeded =
    ctx.totalRedeemAsset > ctx.contractAsset ? ctx.totalRedeemAsset - ctx.contractAsset : 0n;
  if (assetNeeded === 0n) return 0n;
  const usdcNeeded =
    (assetNeeded * ctx.price) / (10n ** ctx.assetDecimals) / (10n ** 12n);
  return usdcNeeded < spendable ? usdcNeeded : spendable;
}

/** Rising tail: skip 11a ETH→USDC swap when USDC shortfall is strictly below this (6-dec USDC). Default $2. */
function getSmallSwapSkipMaxUsdc6(): bigint {
  const raw = process.env.SMALL_SWAP_SKIP_MAX_USDC || '2';
  try {
    const parsed = ethers.parseUnits(raw, 6);
    return parsed > 0n ? parsed : 2_000_000n;
  } catch {
    return 2_000_000n;
  }
}

function strategyAaveDebtToRepay(ctx: OpsContext): bigint {
  if (ctx.aaveDebtFloor != null) {
    return ctx.aaveDebt > ctx.aaveDebtFloor ? ctx.aaveDebt - ctx.aaveDebtFloor : 0n;
  }
  if (ctx.strategyRedeemFraction >= WAD) return ctx.aaveDebt;
  if (ctx.strategyRedeemFraction === 0n || ctx.aaveDebt === 0n) return 0n;
  return (ctx.aaveDebt * ctx.strategyRedeemFraction + WAD - 1n) / WAD;
}

function strategyAaveDebtFloor(ctx: OpsContext): bigint {
  const repay = strategyAaveDebtToRepay(ctx);
  return ctx.aaveDebt > repay ? ctx.aaveDebt - repay : 0n;
}

function usdcShortfallVsContract(ctx: OpsContext): bigint {
  const debtToRepay = strategyAaveDebtToRepay(ctx);
  return debtToRepay > ctx.contractUsdc ? debtToRepay - ctx.contractUsdc : 0n;
}

/**
 * Rising tail: skip partial Aave withdraw + 11a only when shortfall is "dust" vs SMALL_SWAP_SKIP_MAX_USDC
 * **and** owner USDC reserve can fully cover it after `coverUsdcShortfall`. If reserve is 0 (or < shortfall),
 * we must run 11a — otherwise the playbook dead-ends with no USDC on the vault.
 */
async function canSkipSmallSwapViaOwnerReserve(ctx: OpsContext, sf: bigint): Promise<boolean> {
  const cap = getSmallSwapSkipMaxUsdc6();
  if (sf <= 0n || sf >= cap) return false;
  let reserve = 0n;
  try {
    reserve = BigInt((await ctx.kashYield.ownerUsdcReserve()).toString());
  } catch {
    return false;
  }
  return reserve >= sf;
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
    await execTx('depositToAave', ctx.kashYield.depositToAave(toDeposit, aaveTxOverrides()));
  },
};

async function readBatchMintAsset(ctx: OpsContext): Promise<bigint> {
  try {
    const raw = ctx.isBtc
      ? await ctx.kashYield.batchTotalMintBtc(ctx.batchCycle)
      : await ctx.kashYield.batchTotalMintEth(ctx.batchCycle);
    return BigInt(raw.toString());
  } catch {
    return 0n;
  }
}

async function readBatchMintDeployedToAave(ctx: OpsContext): Promise<bigint> {
  try {
    const raw = ctx.isBtc
      ? await ctx.kashYield.batchMintBtcDeployedToAave(ctx.batchCycle)
      : await ctx.kashYield.batchMintEthDeployedToAave(ctx.batchCycle);
    return BigInt(raw.toString());
  } catch {
    return 0n;
  }
}

async function markBatchMintDeployedToAave(ctx: OpsContext, amount: bigint): Promise<void> {
  if (amount === 0n) return;
  try {
    const tx = ctx.isBtc
      ? ctx.kashYield.markMintBtcDeployed(ctx.batchCycle, amount)
      : ctx.kashYield.markMintEthDeployed(ctx.batchCycle, amount);
    await execTx(ctx.isBtc ? 'markMintBtcDeployed' : 'markMintEthDeployed', tx);
  } catch (e: any) {
    console.warn(`         ⚠️  Could not mark batch mint deployed to Aave: ${e?.message ?? e}`);
  }
}

async function computeNetMintAaveDepositAmount(ctx: OpsContext, netMintUSD: bigint): Promise<bigint> {
  if (ctx.contractAsset === 0n || netMintUSD <= 0n) return 0n;
  const pct = BigInt(config.strategy.aaveDepositPct);
  const batchMintAsset = await readBatchMintAsset(ctx);
  const netMintAsset = (netMintUSD * (10n ** ctx.assetDecimals)) / ctx.price;
  const baseAsset = batchMintAsset > 0n && batchMintAsset < netMintAsset ? batchMintAsset : netMintAsset;
  const targetForBatch = (baseAsset * pct) / 100n;
  const alreadyDeployed = await readBatchMintDeployedToAave(ctx);
  const remainingForBatch = targetForBatch > alreadyDeployed ? targetForBatch - alreadyDeployed : 0n;
  return remainingForBatch < ctx.contractAsset ? remainingForBatch : ctx.contractAsset;
}

const aaveDepositNetMint = (netMintUSD: bigint): OpStep => ({
  id: 'aave_deposit',
  substep: 'aave',
  refreshCtx: true,
  describe: (ctx) => {
    const pct = config.strategy.aaveDepositPct;
    const netMintAsset = (netMintUSD * (10n ** ctx.assetDecimals)) / ctx.price;
    return `deposit up to ${pct}% of net mint (${fmtAsset(netMintAsset, ctx)}) to Aave, capped by vault balance`;
  },
  canSkip: async (ctx) => (await computeNetMintAaveDepositAmount(ctx, netMintUSD)) === 0n,
  execute: async (ctx) => {
    const toDeposit = await computeNetMintAaveDepositAmount(ctx, netMintUSD);
    if (toDeposit === 0n) return;
    console.log(`         ${fmtAsset(toDeposit, ctx)} (net mint deposit only; not sweeping older vault asset)`);
    await execTx('depositToAave', ctx.kashYield.depositToAave(toDeposit, aaveTxOverrides()));
    await markBatchMintDeployedToAave(ctx, toDeposit);
  },
});

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
    await execTx('borrowFromAave', ctx.kashYield.borrowFromAave(ctx.aaveUsdcAddress, toBorrow, aaveTxOverrides()));
  },
};

/**
 * USDC to send to HL on mint: all on-chain USDC except we **do not** sweep idle balance above Aave debt.
 * After `aave_borrow`, `contractUsdc` often equals **borrowed USDC + fee buffer** (e.g. ~\$1 for HL withdraw
 * dock). Depositing `min(contractUsdc, aaveDebt)` leaves the buffer on KashYield.
 */
function hlDepositUsdcAmount(ctx: OpsContext): bigint {
  const c = ctx.contractUsdc;
  const d = ctx.aaveDebt;
  if (c === 0n) return 0n;
  if (d === 0n) return c;
  return c < d ? c : d;
}

/** 03 — Deposit USDC to Hyperliquid as collateral (no spot buy — USDC IS the collateral) */
const hlDepositUsdc: OpStep = {
  id: 'hl_deposit_usdc',
  substep: 'hl',
  describe: (ctx) => {
    const amt = hlDepositUsdcAmount(ctx);
    const c = ctx.contractUsdc;
    if (c > amt) {
      return `deposit ${fmtUsdc(amt)} USDC to Hyperliquid (${fmtUsdc(c)} on contract, keeping ${fmtUsdc(c - amt)} as buffer vs Aave debt ${fmtUsdc(ctx.aaveDebt)})`;
    }
    return `deposit ${fmtUsdc(amt)} USDC to Hyperliquid`;
  },
  canSkip: async (ctx) => hlDepositUsdcAmount(ctx) === 0n,
  execute: async (ctx) => {
    const amount = hlDepositUsdcAmount(ctx);
    if (amount === 0n) return;
    const c = ctx.contractUsdc;
    if (c > amount) {
      console.log(`         ${fmtUsdc(amount)} (keeping ${fmtUsdc(c - amount)} USDC on contract — not part of Aave borrow)`);
    } else {
      console.log(`         ${fmtUsdc(amount)}`);
    }

    // Guard: HL adapter must be resolvable (BTC vault had no hyperliquidAddress() view until upgraded)
    let hlAddress = ctx.perpAdapterAddress;
    if (!hlAddress || hlAddress === ethers.ZeroAddress) {
      hlAddress = await readHyperliquidAdapterAddress(ctx.kashYield, ctx.activePerpExchange);
    }
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
    await maybeRunHlEventRelay(ctx, tx.hash, 'EXCHANGE_OPEN_SHORT', { required: true });
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
    const pct = (Number(ctx.strategyRedeemFraction) / 1e16).toFixed(2);
    const closeSize = (ctx.shortSize * ctx.strategyRedeemFraction) / BigInt(1e18);
    return `close ${pct}% strategy unwind of ${ctx.assetSymbol} short (${fmtHlPerpSize(closeSize, ctx)} of ${fmtHlPerpSize(ctx.shortSize, ctx)}; gross redeem ${(Number(ctx.redeemFraction) / 1e16).toFixed(2)}%)`;
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
    const closeSize = (fullSize * ctx.strategyRedeemFraction) / BigInt(1e18);
    if (closeSize === 0n) {
      console.log(`         strategy unwind is 0; no ${symbol} short close needed`);
      return;
    }
    if (closeSize >= fullSize) {
      console.log(`         closing full ${symbol} short`);
      const tx = await ctx.kashYield['closeShort(string)'](symbol);
      await tx.wait();
      console.log('      → closeShort(full) confirmed');
      await maybeRunHlEventRelay(ctx, tx.hash, 'EXCHANGE_CLOSE_SHORT', { required: true });
    } else {
      console.log(`         closing ${fmtHlPerpSize(closeSize, ctx)} of ${fmtHlPerpSize(fullSize, ctx)}`);
      const tx = await ctx.kashYield['closeShort(string,uint256)'](symbol, closeSize);
      await tx.wait();
      console.log('      → closeShort(partial) confirmed');
      await maybeRunHlEventRelay(ctx, tx.hash, 'EXCHANGE_CLOSE_SHORT', { required: true });
    }
  },
};

/** 08 — Withdraw USDC from HL / adapter to contract (pull budget = max(tracked HL spot, adapter ERC-20 on L2)). */
const hlWithdrawUsdc: OpStep = {
  id: 'hl_withdraw_usdc',
  substep: 'hl',
  refreshCtx: true,
  describe: (ctx) => `withdraw ${fmtUsdc(hlUsdcPullBudget(ctx))} USDC (HL spot + adapter ERC-20)`,
  canSkip: async (ctx) => hlUsdcPullBudget(ctx) === 0n,
  execute: async (ctx) => {
    const amount = hlUsdcPullBudget(ctx);
    if (amount === 0n) return;
    console.log(`         ${fmtUsdc(amount)}`);
    const contractAddr = config.kashYieldAddress || await ctx.kashYield.getAddress();
    if (!ctx.usdcAddress || ctx.usdcAddress === ethers.ZeroAddress) {
      throw new Error('Strict HL withdraw check requires usdcAddress on KashYield.');
    }

    const usdc = new ethers.Contract(ctx.usdcAddress, ['function balanceOf(address) view returns (uint256)'], ctx.provider);
    const beforeUsdc = BigInt((await usdc.balanceOf(contractAddr)).toString());
    const { received } = await execHlWithdrawToKashYield(ctx, 'withdrawFromHyperliquid', amount);
    const afterUsdc = BigInt((await usdc.balanceOf(contractAddr)).toString());
    const feeTolerance = getHlWithdrawFeeToleranceUsdc6();

    console.log(`         KashYield USDC balance: ${fmtUsdc(beforeUsdc)} → ${fmtUsdc(afterUsdc)}`);
    if (received + feeTolerance < amount) {
      console.warn(
        `         ⚠️  HL withdraw not fully settled yet: expected ${fmtUsdc(amount)} (tolerance ${fmtUsdc(feeTolerance)}), ` +
        `received ${fmtUsdc(received)}. Waiting/retry logic will run before tail classification.`
      );
    } else if (received < amount) {
      const impliedFee = amount - received;
      console.log(`         fee/slippage accounted: ${fmtUsdc(impliedFee)} (tolerance ${fmtUsdc(feeTolerance)})`);
    }
    await syncHlAdapterFromHyperliquidApi(ctx, true);
  },
};

// ---------------------------------------------------------------------------
// ─── REDEEM TAIL STEPS (falling / rising / balanced) ────────────────────────
// ---------------------------------------------------------------------------

async function executeAaveRepay(ctx: OpsContext): Promise<void> {
  const debtToRepay = strategyAaveDebtToRepay(ctx);
  const amount = ctx.contractUsdc < debtToRepay ? ctx.contractUsdc : debtToRepay;
  if (amount === 0n) return;
  console.log(`         ${fmtUsdc(amount)}`);
  await execTx('repayToAave', ctx.kashYield.repayToAave(ctx.aaveUsdcAddress, amount, aaveTxOverrides()));
}

/** Final repay in rising tail after optional tiny-shortfall swap skip — fails loud if USDC still missing. */
async function executeAaveRepayRisingFinal(ctx: OpsContext): Promise<void> {
  const debtToRepay = strategyAaveDebtToRepay(ctx);
  const amount = ctx.contractUsdc < debtToRepay ? ctx.contractUsdc : debtToRepay;
  if (amount === 0n && debtToRepay > 0n) {
    const cap = getSmallSwapSkipMaxUsdc6();
    const sf = usdcShortfallVsContract(ctx);
    const tinyHint =
      sf > 0n && sf < cap
        ? ` USDC shortfall ${fmtUsdc(sf)} was below SMALL_SWAP_SKIP_MAX_USDC (${fmtUsdc(cap)}), so the 11a ETH→USDC swap was skipped — send that USDC to KashYield and re-run.`
        : ' Fund KashYield with USDC and/or fix 11a spot liquidity, then re-run.';
    throw new Error(
      `Rising tail: cannot repay Aave (debt ${fmtUsdc(ctx.aaveDebt)}, 0 spendable USDC after owner reserve).${tinyHint}` +
        ' If USDC is marked as owner reserve, ensure ownerUsdcReserve ≥ shortfall or send USDC and call markOwnerUsdcDeposit, then re-run.',
    );
  }
  if (amount === 0n) return;
  console.log(`         ${fmtUsdc(amount)}`);
  await execTx('repayToAave', ctx.kashYield.repayToAave(ctx.aaveUsdcAddress, amount, aaveTxOverrides()));
}

function describeAaveRepay(ctx: OpsContext): string {
  const debtToRepay = strategyAaveDebtToRepay(ctx);
  const amount = ctx.contractUsdc < debtToRepay ? ctx.contractUsdc : debtToRepay;
  return `repay ${fmtUsdc(amount)} to Aave (strategy debt target=${fmtUsdc(debtToRepay)}, total debt=${fmtUsdc(ctx.aaveDebt)})`;
}

/** 09 — Repay Aave borrow with all available contract USDC */
const aaveRepay: OpStep = {
  id: 'aave_repay',
  substep: 'aave',
  refreshCtx: true,
  describe: describeAaveRepay,
  canSkip: async (ctx) => strategyAaveDebtToRepay(ctx) === 0n,
  execute: executeAaveRepay,
};

/** Same as aave_repay but used only at end of rising tail for tiny-shortfall error messaging. */
const aaveRepayRisingFinal: OpStep = {
  id: 'aave_repay_rising_final',
  substep: 'aave',
  refreshCtx: true,
  describe: describeAaveRepay,
  canSkip: async (ctx) => strategyAaveDebtToRepay(ctx) === 0n,
  execute: executeAaveRepayRisingFinal,
};

/**
 * Final Aave debt dust sweep. Aave variable debt can accrue a few USDC base units between
 * the repay snapshot and the repay tx. If owner USDC reserve can cover that dust, release
 * just enough reserve and repay before withdrawing remaining collateral / mark-done.
 */
const aaveRepayResidualDebtFromOwnerReserve: OpStep = {
  id: 'aave_repay_residual_owner_dust',
  substep: 'aave',
  refreshCtx: true,
  describe: (ctx) => `cover and repay residual Aave debt ${fmtUsdc(usdcShortfallVsContract(ctx))} from owner USDC reserve`,
  canSkip: async (ctx) => {
    if (ctx.strategyRedeemFraction < WAD) return true;
    const debtToRepay = strategyAaveDebtToRepay(ctx);
    if (debtToRepay === 0n) return true;
    if (ctx.contractUsdc >= debtToRepay) return false;
    let reserve = 0n;
    try {
      reserve = BigInt((await ctx.kashYield.ownerUsdcReserve()).toString());
    } catch {
      reserve = 0n;
    }
    return reserve === 0n;
  },
  execute: async (ctx) => {
    if (ctx.strategyRedeemFraction < WAD) return;
    const debtToRepay = strategyAaveDebtToRepay(ctx);
    if (debtToRepay === 0n) return;
    let spendable = ctx.contractUsdc;
    if (spendable < debtToRepay) {
      const reserve = BigInt((await ctx.kashYield.ownerUsdcReserve()).toString());
      const shortfall = debtToRepay - spendable;
      const cover = shortfall < reserve ? shortfall : reserve;
      if (cover > 0n) {
        console.log(`         coverUsdcShortfall ${fmtUsdc(cover)} for residual Aave debt dust`);
        await execTx('coverUsdcShortfall(residual)', ctx.kashYield.coverUsdcShortfall(cover));
        spendable += cover;
      }
    }
    const amount = spendable < debtToRepay ? spendable : debtToRepay;
    if (amount === 0n) return;
    console.log(`         repay residual ${fmtUsdc(amount)} to Aave (debt=${fmtUsdc(ctx.aaveDebt)})`);
    await execTx('repayToAave(residual)', ctx.kashYield.repayToAave(ctx.aaveUsdcAddress, amount, aaveTxOverrides()));
  },
};

/**
 * Repay from contract USDC only when rising tail: skip entirely if no USDC (avoids no-op step noise).
 * Falling/balanced use `aaveRepay` first, which must still run when debt > 0 even if USDC is 0
 * (e.g. mis-synced snapshot — execute no-ops safely).
 */
const aaveRepayContractFirst: OpStep = {
  id: 'aave_repay_contract_first',
  substep: 'aave',
  refreshCtx: true,
  describe: describeAaveRepay,
  canSkip: async (ctx) => strategyAaveDebtToRepay(ctx) === 0n || ctx.contractUsdc === 0n,
  execute: executeAaveRepay,
};

/**
 * 11b — Swap USDC → asset (falling price tail) after Aave repay.
 *
 * Only swaps **usdcNeeded** for the redeem asset shortfall (`min(usdcNeeded, contractUsdc)`), not all deployable USDC.
 * If `contractAsset` already covers `totalRedeemAsset`, swap size is **0** and USDC from HL / repay stays on the vault.
 * No min-notional skip: any positive `usdcNeeded` (after cap) is swapped.
 *
 * Phase 2 redeem math on-chain: see batchProcessor comment on `currentNAV` / `exactNAV` / oracle timing.
 */
const dexSwapFromUsdc = (_lockedNAV: bigint | undefined): OpStep => ({
  id: 'dex_swap_from_usdc',
  substep: 'aave',
  refreshCtx: true,
  describe: (ctx) => {
    const u = computeFalling11bUsdcToSwap(ctx);
    if (u === 0n) {
      return `no USDC→${ctx.assetSymbol} swap (11b — asset covers redeem need or no deployable USDC)`;
    }
    return `swap ${fmtUsdc(u)} USDC → ${ctx.assetSymbol} (11b, falling price, redeem gap)`;
  },
  canSkip: async (ctx) => {
    const spotDex = await ctx.kashYield.spotDexAddress().catch(() => null);
    if (!spotDex || spotDex === ethers.ZeroAddress) {
      console.log(`         ⚠️  spotDexAddress not configured — skipping 11b swap`);
      return true;
    }
    if (falling11bSpendableUsdc(ctx) === 0n) return true;
    const usdcToSwap = computeFalling11bUsdcToSwap(ctx);
    return usdcToSwap === 0n;
  },
  execute: async (ctx) => {
    const spendable = falling11bSpendableUsdc(ctx);
    if (spendable === 0n) return;
    const assetNeeded =
      ctx.totalRedeemAsset > ctx.contractAsset ? ctx.totalRedeemAsset - ctx.contractAsset : 0n;
    const usdcToSwap = computeFalling11bUsdcToSwap(ctx);
    if (usdcToSwap === 0n) return;
    console.log(
      `         swap ${fmtUsdc(usdcToSwap)} USDC (deployable≤${fmtUsdc(spendable)}) → ~${fmtAsset(assetNeeded, ctx)} for redeem gap`,
    );
    await execTx(
      'swapFromUsdc',
      ctx.kashYield.swapFromUsdc(usdcToSwap, swapTxOverrides()),
    );
  },
});

/**
 * 10 — Withdraw Aave collateral.
 *
 * For falling price and balanced: proportional withdrawal (redeemFraction × aaveSupplied),
 * or full sweep on 100% redemption.
 * For rising price (after partial-withdraw-for-swap):
 * withdraw only what remains to reach totalRedeemAsset, except full strategy redeems
 * sweep all remaining Aave collateral so settlement NAV cannot strand dust in Aave.
 */
const aaveWithdraw = (mode: 'proportional' | 'remaining'): OpStep => ({
  id: mode === 'proportional' ? 'aave_withdraw' : 'aave_withdraw_rest',
  substep: 'aave',
  describe: (ctx) => {
    if (ctx.aaveSupplied === 0n) return 'withdraw from Aave (nothing supplied)';
    if (mode === 'proportional') {
      const isFullStrategyRedeem = ctx.strategyRedeemFraction >= BigInt(1e18);
      if (isFullStrategyRedeem) return `withdraw ALL ${fmtAsset(ctx.aaveSupplied, ctx)} from Aave`;
      const amount = _proportionalWithdrawAmount(ctx);
      return `withdraw ${fmtAsset(amount, ctx)} from Aave (proportional)`;
    }
    // mode === 'remaining': withdraw to top up contract to totalRedeemAsset
    const isFullStrategyRedeem = ctx.strategyRedeemFraction >= WAD;
    if (isFullStrategyRedeem) return `withdraw ALL ${fmtAsset(ctx.aaveSupplied, ctx)} from Aave (remaining full redeem sweep)`;
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
      const isFullStrategyRedeem = ctx.strategyRedeemFraction >= WAD;
      amount = isFullStrategyRedeem ? ctx.aaveSupplied : _proportionalWithdrawAmount(ctx);
    } else {
      const isFullStrategyRedeem = ctx.strategyRedeemFraction >= WAD;
      if (isFullStrategyRedeem) {
        amount = ctx.aaveSupplied;
      } else {
      const needed = ctx.totalRedeemAsset > ctx.contractAsset
        ? ctx.totalRedeemAsset - ctx.contractAsset
        : 0n;
      amount = needed < ctx.aaveSupplied ? needed : ctx.aaveSupplied;
      }
    }
    if (amount === 0n) return;
    console.log(`         ${fmtAsset(amount, ctx)}`);
    await execTx('withdrawFromAave', ctx.kashYield.withdrawFromAave(amount, aaveTxOverrides()));
  },
});

/**
 * 10-partial — Withdraw a small amount of Aave collateral to cover USDC shortfall (rising price).
 * Runs BEFORE aave_repay in the rising-price path.
 * Size: (strategy debt target - contractUsdc) converted to asset units at current price.
 */
const aaveWithdrawPartial: OpStep = {
  id: 'aave_withdraw_partial',
  substep: 'aave',
  refreshCtx: true,
  describe: (ctx) => {
    const shortfall = usdcShortfallVsContract(ctx);
    const assetForSf =
      shortfall > 0n ? (shortfall * (10n ** 12n) * (10n ** ctx.assetDecimals)) / ctx.price : 0n;
    const redeemGap = ctx.totalRedeemAsset > ctx.contractAsset ? ctx.totalRedeemAsset - ctx.contractAsset : 0n;
    return `partial Aave withdraw ${fmtAsset(assetForSf, ctx)} for 11a USDC shortfall ${fmtUsdc(shortfall)}; redeem gap ${fmtAsset(redeemGap, ctx)} handled after repay`;
  },
  canSkip: async (ctx) => {
    if (ctx.aaveSupplied === 0n) return true;

    const sf = usdcShortfallVsContract(ctx);
    if (sf === 0n) return true; // no USDC shortfall for the debt slice being unwound
    const cap = getSmallSwapSkipMaxUsdc6();
    if (sf > 0n && sf < cap) {
      if (await canSkipSmallSwapViaOwnerReserve(ctx, sf)) {
        console.log(
          `         ↪ skip partial Aave withdraw — shortfall ${fmtUsdc(sf)} < ${fmtUsdc(cap)} ` +
            '(SMALL_SWAP_SKIP_MAX_USDC) and ownerUsdcReserve ≥ shortfall (coverUsdcShortfall path)',
        );
        return true;
      }
      console.log(
        `         ↪ shortfall ${fmtUsdc(sf)} < ${fmtUsdc(cap)} but owner reserve cannot fully cover — running partial withdraw + 11a`,
      );
    }
    const spotDex = await ctx.kashYield.spotDexAddress().catch(() => null);
    if (!spotDex || spotDex === ethers.ZeroAddress) {
      console.warn('         ⚠️  spotDexAddress not configured — cannot cover USDC shortfall via 11a');
      return true;
    }
    return false;
  },
  execute: async (ctx) => {
    const sf = usdcShortfallVsContract(ctx);
    const cap = getSmallSwapSkipMaxUsdc6();
    const smallSkipOwner =
      sf > 0n && sf < cap && (await canSkipSmallSwapViaOwnerReserve(ctx, sf));

    let assetForShortfall = 0n;
    if (!smallSkipOwner && sf > 0n) {
      assetForShortfall = (sf * (10n ** 12n) * (10n ** ctx.assetDecimals)) / ctx.price;
    } else if (smallSkipOwner && sf > 0n) {
      console.log(
        `         ↪ USDC shortfall ${fmtUsdc(sf)} < ${fmtUsdc(cap)} with owner reserve — no Aave pull for swap; ` +
          'withdrawing max(redeem gap, 0) only',
      );
    }

    const redeemGap = ctx.totalRedeemAsset > ctx.contractAsset ? ctx.totalRedeemAsset - ctx.contractAsset : 0n;
    let toWithdraw = assetForShortfall;
    if (toWithdraw === 0n) return;
    if (toWithdraw > ctx.aaveSupplied) toWithdraw = ctx.aaveSupplied;
    console.log(
      `         ${fmtAsset(toWithdraw, ctx)} (for swap≤${fmtAsset(assetForShortfall, ctx)}, redeem gap ${fmtAsset(redeemGap, ctx)})`,
    );
    await execTx('withdrawFromAave(partial)', ctx.kashYield.withdrawFromAave(toWithdraw, aaveTxOverrides()));
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
    const shortfall = usdcShortfallVsContract(ctx);
    const assetToSell = (shortfall * (10n ** 12n) * (10n ** ctx.assetDecimals)) / ctx.price;
    return `swap ${fmtAsset(assetToSell, ctx)} → USDC to cover ${fmtUsdc(shortfall)} shortfall (11a)`;
  },
  canSkip: async (ctx) => {
    const sf = usdcShortfallVsContract(ctx);
    if (sf === 0n) return true; // gap already closed for the debt slice being unwound
    const cap = getSmallSwapSkipMaxUsdc6();
    if (sf > 0n && sf < cap) {
      if (await canSkipSmallSwapViaOwnerReserve(ctx, sf)) {
        console.log(
          `         ↪ skip 11a swap — shortfall ${fmtUsdc(sf)} < ${fmtUsdc(cap)} USDC ` +
            '(SMALL_SWAP_SKIP_MAX_USDC) and ownerUsdcReserve ≥ shortfall',
        );
        return true;
      }
      console.log(
        `         ↪ shortfall ${fmtUsdc(sf)} < ${fmtUsdc(cap)} USDC — running 11a (owner reserve cannot fully cover)`,
      );
    }
    const spotDex = await ctx.kashYield.spotDexAddress().catch(() => null);
    if (!spotDex || spotDex === ethers.ZeroAddress) {
      console.warn('         ⚠️  spotDexAddress not configured — skipping 11a swap');
      return true;
    }
    return false;
  },
  execute: async (ctx) => {
    const shortfall = usdcShortfallVsContract(ctx);
    if (shortfall === 0n) return;
    const assetToSell = (shortfall * (10n ** 12n) * (10n ** ctx.assetDecimals)) / ctx.price;
    // Cap to what contract actually holds
    const toSell = assetToSell < ctx.contractAsset ? assetToSell : ctx.contractAsset;
    if (toSell === 0n) return;
    console.log(`         sell ${fmtAsset(toSell, ctx)} → cover ${fmtUsdc(shortfall)}`);
    const swapOpts = swapTxOverrides();
    if (Object.keys(swapOpts).length > 0) {
      console.log(`         (OPS_SWAP_GAS_LIMIT set — swap tx uses explicit gasLimit, real Uniswap on-chain)`);
    }
    await execTx('swapForUsdc', ctx.kashYield.swapForUsdc(toSell, swapOpts));
  },
};

/**
 * After 11a / partial-withdraw may be skipped (e.g. SMALL_SWAP_SKIP), residual Aave debt can remain
 * while USDC is already on the vault but counted only in ownerUsdcReserve. coverUsdcShortfall is
 * accounting-only: it releases up to min(shortfall, reserve) into the bot's spendable contractUsdc.
 */
const risingTailCoverOwnerUsdc: OpStep = {
  id: 'rising_tail_cover_owner_usdc',
  substep: 'aave',
  refreshCtx: true,
  describe: (ctx) => {
    const sf = usdcShortfallVsContract(ctx);
    return `cover USDC shortfall from owner reserve up to ${fmtUsdc(sf)} (coverUsdcShortfall)`;
  },
  canSkip: async (ctx) => {
    if (ctx.aaveDebt === 0n) return true;
    if (usdcShortfallVsContract(ctx) === 0n) return true;
    let reserve = 0n;
    try {
      reserve = BigInt((await ctx.kashYield.ownerUsdcReserve()).toString());
    } catch {
      return true;
    }
    return reserve === 0n;
  },
  execute: async (ctx) => {
    const sf = usdcShortfallVsContract(ctx);
    if (sf === 0n) return;
    const reserve = BigInt((await ctx.kashYield.ownerUsdcReserve()).toString());
    const amount = sf < reserve ? sf : reserve;
    if (amount === 0n) return;
    console.log(
      `         coverUsdcShortfall ${fmtUsdc(amount)} (shortfall ${fmtUsdc(sf)}, ownerUsdcReserve ${fmtUsdc(reserve)})`,
    );
    await execTx('coverUsdcShortfall', ctx.kashYield.coverUsdcShortfall(amount));
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

function isInsufficientHlMarginError(e: any): boolean {
  const msg = String(e?.message ?? e ?? '');
  return /insufficient margin/i.test(msg);
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

async function readHlPositionSize(
  info: any,
  hlUser: string,
  symbol: string,
  assetDecimals: number,
): Promise<bigint> {
  const ch: any = await info.clearinghouseState({ user: hlUser });
  const pos = findPosition(ch, symbol);
  return decimalToBigInt(absDecimal(pos?.position?.szi || '0'), assetDecimals);
}

async function waitForHlPositionAtLeast(
  info: any,
  hlUser: string,
  symbol: string,
  assetDecimals: number,
  minSize: bigint,
): Promise<void> {
  const maxMs = hlOpenShortWaitMaxMs();
  const pollMs = hlOpenShortWaitPollMs();
  const start = Date.now();

  while (true) {
    const actual = await readHlPositionSize(info, hlUser, symbol, assetDecimals);
    if (actual >= minSize) {
      console.log(`      → HL position confirmed: ${ethers.formatUnits(actual, assetDecimals)} ${symbol}`);
      return;
    }

    if (Date.now() - start >= maxMs) {
      throw new Error(
        `HL open short not confirmed: position ${ethers.formatUnits(actual, assetDecimals)} ${symbol} ` +
          `< expected ${ethers.formatUnits(minSize, assetDecimals)} ${symbol}`,
      );
    }

    console.log(
      `      ↪ waiting for HL position confirmation: ${ethers.formatUnits(actual, assetDecimals)} / ` +
        `${ethers.formatUnits(minSize, assetDecimals)} ${symbol}`,
    );
    await sleep(pollMs);
  }
}

/** Confirm HL short size dropped after closeShort relay (reduce-only IOC fill). */
async function waitForHlShortCloseConfirmed(
  info: any,
  hlUser: string,
  symbol: string,
  assetAliases: string,
  hlPositionDecimals: number,
  sizeBefore: bigint,
  placedSize: bigint,
  fullClose: boolean,
): Promise<void> {
  const maxMs = hlOpenShortWaitMaxMs();
  const pollMs = hlOpenShortWaitPollMs();
  const start = Date.now();
  const needReduction = fullClose ? sizeBefore : placedSize < sizeBefore ? placedSize : sizeBefore;

  while (true) {
    const after = await readHlPositionSize(info, hlUser, symbol, hlPositionDecimals);
    const reduced = sizeBefore > after ? sizeBefore - after : 0n;
    if (fullClose && after === 0n) {
      console.log(`      → HL short fully closed (0 ${assetAliases})`);
      return;
    }
    if (!fullClose && (reduced >= needReduction || after === 0n)) {
      console.log(
        `      → HL short reduced by ${ethers.formatUnits(reduced, hlPositionDecimals)} ${assetAliases} ` +
          `(before ${ethers.formatUnits(sizeBefore, hlPositionDecimals)})`,
      );
      return;
    }

    if (Date.now() - start >= maxMs) {
      throw new Error(
        `HL closeShort not confirmed: ${symbol} before=${ethers.formatUnits(sizeBefore, hlPositionDecimals)} ` +
          `after=${ethers.formatUnits(after, hlPositionDecimals)} needReduction≈${ethers.formatUnits(needReduction, hlPositionDecimals)}`,
      );
    }

    console.log(
      `      ↪ waiting for HL close: size ${ethers.formatUnits(after, hlPositionDecimals)} ${assetAliases} ` +
        `(reduced ${ethers.formatUnits(reduced, hlPositionDecimals)})`,
    );
    await sleep(pollMs);
  }
}

/**
 * Push HL API spot / perp state into the on-chain adapter so `getHyperliquidSpotBalance()` matches reality.
 * HL withdraws can deduct ~1 USDC fee off-chain; without this, stale adapter USDC triggers pointless sweep retries.
 *
 * @param respectWithdrawSyncEnv — when true, honors `HL_SYNC_AFTER_WITHDRAW` (default on). Relay path passes false.
 */
async function syncHlAdapterFromHyperliquidApi(
  ctx: OpsContext,
  respectWithdrawSyncEnv: boolean,
): Promise<void> {
  if (!ctx.perpAdapterAddress || ctx.perpAdapterAddress === ethers.ZeroAddress) return;
  if (respectWithdrawSyncEnv) {
    const enabled = (process.env.HL_SYNC_AFTER_WITHDRAW ?? 'true').toLowerCase() !== 'false';
    if (!enabled) return;
  }

  const signerPk = process.env.HYPERLIQUID_API_PRIVATE_KEY || config.privateKey;
  if (!signerPk) {
    console.warn(
      '      ⚠️  HL adapter sync skipped: set PRIVATE_KEY or HYPERLIQUID_API_PRIVATE_KEY for adapter txs',
    );
    return;
  }
  const hlUser = hlUserAddress(ctx);
  if (!hlUser || hlUser === ethers.ZeroAddress) {
    console.warn('      ⚠️  HL adapter sync skipped: could not resolve HL user');
    return;
  }

  const { InfoClient, HttpTransport } = await import('@nktkas/hyperliquid');
  const hlApiUrl = (process.env.HYPERLIQUID_API_URL || 'https://api.hyperliquid.xyz').replace(/\/+$/, '');
  const info = new InfoClient({ transport: new HttpTransport({ apiUrl: hlApiUrl }) });

  const ch: any = await info.clearinghouseState({ user: hlUser });
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

  const signer = new ethers.Wallet(config.privateKey || signerPk, ctx.provider);
  const adapter = new ethers.Contract(
    ctx.perpAdapterAddress,
    [
      'function syncBalances(uint256 newUsdcBalance, uint256 newAssetBalance) external',
      'function syncPosition(string symbol, uint256 size, uint256 entryPrice, bool isActive) external',
    ],
    signer,
  );

  await (await adapter.syncBalances(usdc6, asset18)).wait();
  await (await adapter.syncPosition(ctx.assetSymbol, size18, entry18, isActive)).wait();
  console.log('      → HL adapter syncBalances + syncPosition confirmed');
}

async function maybeRunHlEventRelay(
  ctx: OpsContext,
  txHash: string,
  expected: HlIntent,
  options?: { required?: boolean },
): Promise<void> {
  const required = options?.required === true;
  if (!isRelayEnabled(ctx)) {
    if (required) throw new Error(`${expected}: HL event relay is disabled; cannot confirm real Hyperliquid execution`);
    return;
  }
  const signerPk = process.env.HYPERLIQUID_API_PRIVATE_KEY || config.privateKey;
  if (!signerPk) {
    const msg = `${expected}: missing HYPERLIQUID_API_PRIVATE_KEY (or PRIVATE_KEY) for HL relay`;
    if (required || relayStrictMode()) throw new Error(msg);
    console.warn(`      ⚠️  ${msg}`);
    return;
  }

  const hlUser = hlUserAddress(ctx);
  if (!hlUser || hlUser === ethers.ZeroAddress) {
    const msg = `${expected}: unable to resolve HL user address`;
    if (required || relayStrictMode()) throw new Error(msg);
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
    const requestedSize = BigInt(parsed.args[1].toString());
    const assetDecimals = Number(ctx.assetDecimals);
    const rawSize = ethers.formatUnits(requestedSize, assetDecimals);
    const size = formatHlSize(rawSize, szDecimals);
    if (!size || size === '0') throw new Error(`computed HL order size is 0 after szDecimals=${szDecimals} rounding`);
    const placedSize = decimalToBigInt(size, assetDecimals);
    const px = formatHlLimitPx(mids[symbol], false, szDecimals);
    const beforeSize = await readHlPositionSize(info, hlUser, symbol, assetDecimals);
    const expectedSize = beforeSize + placedSize;
    const maxMs = hlOpenShortWaitMaxMs();
    const pollMs = hlOpenShortWaitPollMs();
    const start = Date.now();

    while (true) {
      console.log(`      ↪ HL relay: SELL ${size} ${symbol} @ IOC ${px}`);
      try {
        await exchange.order({
          orders: [{ a: assetId, b: false, p: px, s: size, r: false, t: { limit: { tif: 'Ioc' } } }],
          grouping: 'na',
        }, orderOpts as any);
        break;
      } catch (e: any) {
        if (!isInsufficientHlMarginError(e) || Date.now() - start >= maxMs) throw e;
        console.warn(
          `      ⚠️  HL openShort waiting for usable margin: ${e?.message ?? e}. ` +
            `Retrying in ${(pollMs / 1000).toFixed(0)}s...`,
        );
        await sleep(pollMs);
      }
    }
    await waitForHlPositionAtLeast(info, hlUser, symbol, assetDecimals, expectedSize);
  } else if (expected === 'EXCHANGE_CLOSE_SHORT') {
    const symbol = String(parsed.args[0]).toUpperCase();
    // Adapter + partial closeShort(uint256) use 18-dec internal perp size (HyperliquidAdapter.positions).
    // Do not use ctx.assetDecimals (8 for wBTC) here; that mis-scales partial closes by 10^(18-8).
    const beforeSize = await readHlPositionSize(info, hlUser, symbol, HL_PERP_SIZE_DECIMALS);
    if (beforeSize === 0n) {
      console.log(`      ↪ HL relay: no open ${symbol} short on HL — close relay skipped`);
      return;
    }

    let closeSizeWei = 0n;
    if (parsed.name === 'closeShort' && parsed.args.length > 1) {
      closeSizeWei = BigInt(parsed.args[1].toString());
    } else {
      closeSizeWei = beforeSize;
    }

    if (closeSizeWei > 0n) {
      const assetId = findPerpAssetId(perpMeta, symbol);
      const szDecimals = Number(perpMeta?.universe?.[assetId]?.szDecimals ?? 0);
      const rawSize = ethers.formatUnits(closeSizeWei, HL_PERP_SIZE_DECIMALS);
      const size = formatHlSize(rawSize, szDecimals);
      if (!size || size === '0') {
        const msg = `HL relay: close size rounds to 0 at szDecimals=${szDecimals}`;
        if (required) throw new Error(msg);
        console.log(`      ↪ ${msg}; skipping close order`);
        return;
      }
      const placedSize = decimalToBigInt(size, HL_PERP_SIZE_DECIMALS);
      const px = formatHlLimitPx(mids[symbol], true, szDecimals);
      const fullClose = parsed.name === 'closeShort' && parsed.args.length === 1;
      console.log(`      ↪ HL relay: BUY ${size} ${symbol} reduce-only @ IOC ${px}`);
      await exchange.order({
        orders: [{ a: assetId, b: true, p: px, s: size, r: true, t: { limit: { tif: 'Ioc' } } }],
        grouping: 'na',
      }, orderOpts as any);
      if (required) {
        await waitForHlShortCloseConfirmed(
          info,
          hlUser,
          symbol,
          ctx.assetSymbol,
          HL_PERP_SIZE_DECIMALS,
          beforeSize,
          placedSize,
          fullClose,
        );
      }
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

  await syncHlAdapterFromHyperliquidApi(ctx, false);
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
    aaveDepositNetMint(netMintUSD),
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
      // Repay in full → sweep residual Aave debt dust → swap excess USDC to asset (11b) → proportional Aave withdraw
      return [
        aaveRepay,
        aaveRepayResidualDebtFromOwnerReserve,
        dexSwapFromUsdc(lockedNAV),
        aaveWithdraw('proportional'),
      ];

    case 'rising':
      // Repay with all contract USDC first (idle USDC + HL proceeds) to shrink HL-fee / bridge gaps,
      // then partial Aave withdraw → swap asset to USDC (11a) → owner reserve cover if 11a skipped →
      // repay remainder → remaining Aave withdraw
      return [
        aaveRepayContractFirst,
        aaveWithdrawPartial,
        dexSwapForUsdc,
        risingTailCoverOwnerUsdc,
        aaveRepayRisingFinal,
        aaveRepayResidualDebtFromOwnerReserve,
        aaveWithdraw('remaining'),
      ];

    case 'balanced':
      // Repay fully → sweep residual Aave debt dust → proportional Aave withdraw
      return [
        aaveRepay,
        aaveRepayResidualDebtFromOwnerReserve,
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
  console.log(
    `\n💸 NET_REDEEM (${ctx.assetSymbol}) — gross redeem ${(Number(ctx.redeemFraction) / 1e16).toFixed(2)}%, ` +
      `strategy unwind ${(Number(ctx.strategyRedeemFraction) / 1e16).toFixed(2)}%\n`,
  );

  // Step 1: Run core steps (close short + withdraw USDC from HL).
  // Each step has refreshCtx=true so ctx is up-to-date for canSkip checks.
  const coreSteps = buildRedeemCore();
  await runPlaybook(coreSteps, ctx);

  // Step 2: Refresh context to read the actual USDC balance now in the contract.
  let freshCtx = await snapshotOpsContext(ctx.kashYield, ctx.provider, ctx.batchCycle, lockedNAV);
  freshCtx.aaveDebtFloor = strategyAaveDebtFloor(freshCtx);
  freshCtx = await waitForHlWithdrawSettlementIfNeeded(freshCtx, lockedNAV);

  // Step 3: Classify tail from freshCtx (contractUsdc vs strategy debt target) and run tail steps.
  const tail: RedeemTail = classifyRedeemTail(freshCtx);
  console.log(`   📊 Redeem tail: ${tailLabel(tail)}`);
  console.log(
    `      contractUsdc=${fmtUsdc(freshCtx.contractUsdc)}, ` +
      `strategyDebt=${fmtUsdc(strategyAaveDebtToRepay(freshCtx))}, totalDebt=${fmtUsdc(freshCtx.aaveDebt)}\n`,
  );

  const tailSteps = buildRedeemTail(tail, lockedNAV);
  await runPlaybook(tailSteps, freshCtx);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 100% of KASH supply redeemed this batch — drain HL spot USDC, not just “enough to repay Aave”. */
function isFullRedeemForHlSweep(ctx: OpsContext): boolean {
  return ctx.redeemFraction >= BigInt(1e18);
}

/** Upper bound for moving USDC adapter → KashYield: max(HL-tracked spot, adapter ERC-20 on L2). */
function hlUsdcPullBudget(ctx: OpsContext): bigint {
  return ctx.hlUsdcBalance > ctx.adapterUsdcErc20 ? ctx.hlUsdcBalance : ctx.adapterUsdcErc20;
}

/**
 * How much USDC to pull from HL during settlement retries. Partial redeems only pull up to the Aave
 * debt gap so we do not strand strategy collateral on HL incorrectly. Full redeems always pull the
 * full reported HL spot balance so pre-funded vault USDC cannot leave HL USDC behind.
 */
function hlSettlementWithdrawAmount(ctx: OpsContext, debtRemaining: bigint): bigint {
  const pullBudget = hlUsdcPullBudget(ctx);
  if (pullBudget === 0n) return 0n;
  if (isFullRedeemForHlSweep(ctx)) return pullBudget;
  if (debtRemaining <= 0n) return 0n;
  return pullBudget < debtRemaining ? pullBudget : debtRemaining;
}

function getHlSweepDustUsdc6(): bigint {
  try {
    const u = process.env.HL_SWEEP_DUST_USDC || '0.01';
    const p = ethers.parseUnits(u, 6);
    return p > 0n ? p : 10_000n;
  } catch {
    return 10_000n;
  }
}

/**
 * After Aave debt is covered, USDC can still sit on HL if retries used min(hl, debtGap) or the vault
 * was pre-funded. For full redeems, sweep remaining HL spot USDC to KashYield (with polling).
 */
async function sweepRemainingHlUsdcAfterFullRedeem(
  ctx: OpsContext,
  lockedNAV: bigint | undefined,
): Promise<OpsContext> {
  const defaultSweep = isFullRedeemForHlSweep(ctx);
  const want = (process.env.HL_REDEEM_SWEEP_REMAINING_USDC || (defaultSweep ? 'true' : 'false')).toLowerCase() === 'true';
  if (!want) return ctx;

  const dust = getHlSweepDustUsdc6();
  const maxRounds = Math.max(1, parseInt(process.env.HL_USDC_SWEEP_MAX_ROUNDS || '15', 10));
  const pollMs = Math.max(1000, parseInt(process.env.HL_WITHDRAW_WAIT_POLL_MS || '20000', 10));
  let fresh = ctx;
  let rounds = 0;

  while (rounds < maxRounds && hlUsdcPullBudget(fresh) > dust) {
    rounds++;
    const amt = hlUsdcPullBudget(fresh);
    console.log(`   ↪ HL USDC sweep #${rounds}: withdraw ${fmtUsdc(amt)} (full spot balance)`);
    try {
      await execHlWithdrawToKashYield(fresh, `withdrawFromHyperliquid(sweep#${rounds})`, amt);
      await syncHlAdapterFromHyperliquidApi(fresh, true);
    } catch (e: any) {
      console.warn(`      ⚠️  HL sweep #${rounds} failed: ${e?.message ?? e}`);
    }
    await sleep(pollMs);
    const nextFresh = await snapshotOpsContext(fresh.kashYield, fresh.provider, fresh.batchCycle, lockedNAV);
    nextFresh.aaveDebtFloor = fresh.aaveDebtFloor;
    fresh = nextFresh;
    console.log(`      ↪ sweep status: contractUsdc=${fmtUsdc(fresh.contractUsdc)}, hlUsdc=${fmtUsdc(fresh.hlUsdcBalance)}, adapterUsdc=${fmtUsdc(fresh.adapterUsdcErc20)}`);
  }

  if (hlUsdcPullBudget(fresh) > dust) {
    console.warn(
      `   ⚠️  HL / adapter still holds ~${fmtUsdc(hlUsdcPullBudget(fresh))} USDC (tracked HL + adapter ERC-20) after ${maxRounds} sweep rounds — ` +
        'bridge may be slow; re-run ops or withdraw manually.',
    );
  } else if (rounds > 0) {
    console.log(`   ✅ HL USDC sweep complete (≤${fmtUsdc(dust)} dust)`);
  }
  return fresh;
}

async function waitForHlWithdrawSettlementIfNeeded(
  ctx: OpsContext,
  lockedNAV: bigint | undefined,
): Promise<OpsContext> {
  const enabled = (process.env.HL_WITHDRAW_WAIT_ENABLED || 'true').toLowerCase() !== 'false';
  const feeTolerance = getHlWithdrawFeeToleranceUsdc6();

  if (!enabled) {
    return sweepRemainingHlUsdcAfterFullRedeem(ctx, lockedNAV);
  }

  let fresh = ctx;

  if (fresh.aaveDebt === 0n) {
    return sweepRemainingHlUsdcAfterFullRedeem(fresh, lockedNAV);
  }

  const debtGap0 = usdcShortfallVsContract(fresh);
  if (debtGap0 <= feeTolerance) {
    // Debt already covered (e.g. pre-funded vault USDC) — still sweep HL so USDC is not stranded.
    return sweepRemainingHlUsdcAfterFullRedeem(fresh, lockedNAV);
  }

  const maxMs = Math.max(0, parseInt(process.env.HL_WITHDRAW_WAIT_MAX_MS || '360000', 10)); // default 6 min
  const pollMs = Math.max(1000, parseInt(process.env.HL_WITHDRAW_WAIT_POLL_MS || '20000', 10)); // default 20s
  if (maxMs === 0) {
    return sweepRemainingHlUsdcAfterFullRedeem(fresh, lockedNAV);
  }

  console.log(
    `   ⏳ Waiting for HL withdrawal settlement (up to ${(maxMs / 1000).toFixed(0)}s, poll ${(pollMs / 1000).toFixed(0)}s)` +
    ` — strategyDebt=${fmtUsdc(strategyAaveDebtToRepay(fresh))}, totalDebt=${fmtUsdc(fresh.aaveDebt)}, contractUsdc=${fmtUsdc(fresh.contractUsdc)}, ` +
    `adapterUsdc=${fmtUsdc(fresh.adapterUsdcErc20)}, hlUsdc=${fmtUsdc(fresh.hlUsdcBalance)}`,
  );

  const started = Date.now();
  let attempts = 0;
  let withdrawInitiated = false;

  while (Date.now() - started < maxMs) {
    const debtRemaining = usdcShortfallVsContract(fresh);
    if (debtRemaining <= feeTolerance) break;

    const pullAmt = hlSettlementWithdrawAmount(fresh, debtRemaining);

    if (!withdrawInitiated && pullAmt > 0n && fresh.hlUsdcBalance > 0n) {
      try {
        await maybeInitiateHlOffchainWithdraw(fresh, pullAmt);
        withdrawInitiated = true;
      } catch (e: any) {
        console.warn(`      ⚠️  HL off-chain withdraw initiation failed: ${e?.message ?? e}`);
      }
    }

    if (pullAmt > 0n) {
      attempts++;
      console.log(`      ↪ settlement retry #${attempts}: withdraw ${fmtUsdc(pullAmt)} from HL`);
      try {
        await execHlWithdrawToKashYield(fresh, `withdrawFromHyperliquid(retry#${attempts})`, pullAmt);
        await syncHlAdapterFromHyperliquidApi(fresh, true);
      } catch (e: any) {
        console.warn(`      ⚠️  settlement retry #${attempts} failed: ${e?.message ?? e}`);
      }
    }

    await sleep(pollMs);
    const nextFresh = await snapshotOpsContext(fresh.kashYield, fresh.provider, fresh.batchCycle, lockedNAV);
    nextFresh.aaveDebtFloor = fresh.aaveDebtFloor;
    fresh = nextFresh;
    console.log(
      `      ↪ settlement status: contractUsdc=${fmtUsdc(fresh.contractUsdc)}, strategyDebt=${fmtUsdc(strategyAaveDebtToRepay(fresh))}, totalDebt=${fmtUsdc(fresh.aaveDebt)}, ` +
        `hlUsdc=${fmtUsdc(fresh.hlUsdcBalance)}, adapterUsdc=${fmtUsdc(fresh.adapterUsdcErc20)}`,
    );
    const shortfallNow = usdcShortfallVsContract(fresh);
    if (shortfallNow <= feeTolerance) break;
  }

  const finalShortfall = usdcShortfallVsContract(fresh);
  if (finalShortfall > feeTolerance && hlUsdcPullBudget(fresh) > feeTolerance) {
    throw new Error(
      `HL withdraw settlement incomplete: contract USDC ${fmtUsdc(fresh.contractUsdc)} < strategy Aave debt target ${fmtUsdc(strategyAaveDebtToRepay(fresh))} ` +
        `(shortfall ${fmtUsdc(finalShortfall)}, total Aave debt ${fmtUsdc(fresh.aaveDebt)}). Stopping before tail classification; wait for HL USDC to arrive, then re-run ops.`,
    );
  }
  if (finalShortfall > feeTolerance) {
    console.log(
      `   ↪ HL settlement has no remaining pull budget; proceeding to rising tail with strategy debt shortfall=${fmtUsdc(finalShortfall)}`,
    );
  } else if (finalShortfall > 0n) {
    console.log(`   ✅ HL settlement wait complete within fee tolerance: shortfall=${fmtUsdc(finalShortfall)} (tolerance ${fmtUsdc(feeTolerance)})`);
  } else {
    console.log('   ✅ HL settlement wait complete: contract USDC now covers strategy Aave debt target');
  }

  return sweepRemainingHlUsdcAfterFullRedeem(fresh, lockedNAV);
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
 * Proportional Aave withdrawal for partial strategy unwind: release at most
 * strategyRedeemFraction × supplied, capped by post-mint redeem asset gap on the vault.
 */
function _proportionalWithdrawAmount(ctx: OpsContext): bigint {
  const stratFrac = ctx.strategyRedeemFraction;
  const redeemGap =
    ctx.totalRedeemAsset > ctx.contractAsset ? ctx.totalRedeemAsset - ctx.contractAsset : 0n;
  const capFromStrategy = (ctx.aaveSupplied * stratFrac) / BigInt(1e18);
  if (redeemGap === 0n) return 0n;
  return redeemGap < capFromStrategy ? redeemGap : capFromStrategy;
}
