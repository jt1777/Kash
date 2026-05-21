/**
 * Manual test playbook (OPS_SCENARIO=test_aave_loop) — not used in production batches.
 */

import { ethers } from 'ethers';
import { config } from '../config';
import type { OpsContext } from './opsContext';
import { runPlaybook, type OpStep, aaveDeposit, aaveBorrow } from './opsExec';

function fmtUsdc(v: bigint): string {
  return ethers.formatUnits(v, 6) + ' USDC';
}
function fmtAsset(v: bigint, ctx: OpsContext): string {
  return ethers.formatUnits(v, Number(ctx.assetDecimals)) + ' ' + ctx.assetSymbol;
}
function fmtUsd(v: bigint): string {
  return '$' + ethers.formatEther(v);
}

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
    const tx = await ctx.kashYield.swapFromUsdc(amount);
    await tx.wait();
    console.log('      → swapFromUsdc confirmed');
  },
};

export function buildAaveLoopPlaybook(): OpStep[] {
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

export async function runTestAaveLoopPlaybook(ctx: OpsContext): Promise<void> {
  const price = ctx.price;
  const assetStr = fmtAsset(ctx.contractAsset, ctx);
  const usdStr = fmtUsd((ctx.contractAsset * price) / (10n ** ctx.assetDecimals));
  const ltv = config.strategy.borrowLtvPct;
  const round1BorrowUsdc =
    (ctx.contractAsset * price * BigInt(ltv)) / (100n * (10n ** ctx.assetDecimals) * (10n ** 12n));
  const round1SwapEth = (round1BorrowUsdc * (10n ** 12n) * (10n ** ctx.assetDecimals)) / price;
  const round2BorrowUsdc =
    (round1SwapEth * price * BigInt(ltv)) / (100n * (10n ** ctx.assetDecimals) * (10n ** 12n));

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

  await runPlaybook(buildAaveLoopPlaybook(), ctx);

  console.log('\n🧪 Test loop complete. Final state will be snapshotted on next run.\n');
}
