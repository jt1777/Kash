/**
 * Manual test playbook (OPS_SCENARIO=test_aave_loop) — not used in production batches.
 */

import { ethers } from 'ethers';
import { config } from '../config';
import type { OpsContext } from './opsContext';
import {
  runPlaybook,
  type OpStep,
  aaveBorrow,
  aaveLoopSwapAllUsdcToAsset,
  aaveLoopDepositAllAsset,
} from './opsExec';

function fmtUsdc(v: bigint): string {
  return ethers.formatUnits(v, 6) + ' USDC';
}
function fmtAsset(v: bigint, ctx: OpsContext): string {
  return ethers.formatUnits(v, Number(ctx.assetDecimals)) + ' ' + ctx.assetSymbol;
}
function fmtUsd(v: bigint): string {
  return '$' + ethers.formatEther(v);
}

export function buildAaveLoopPlaybook(): OpStep[] {
  return [
    { ...aaveLoopDepositAllAsset, id: 'aave_deposit_round1' },
    { ...aaveBorrow, id: 'aave_borrow_round1' },
    { ...aaveLoopSwapAllUsdcToAsset, id: 'dex_swap_usdc_to_asset' },
    { ...aaveLoopDepositAllAsset, id: 'aave_deposit_round2' },
    { ...aaveBorrow, id: 'aave_borrow_round2' },
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
