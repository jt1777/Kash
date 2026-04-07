import { ethers } from 'ethers';
import { config } from '../config';
import type { OpsContext } from './opsContext';

// ---------------------------------------------------------------------------
// Scenario taxonomy
// ---------------------------------------------------------------------------

/**
 * Top-level ops scenario — determined before any steps run.
 * Redeem sub-variants (falling/rising/balanced) are detected reactively mid-playbook
 * after the short close and USDC withdrawal, when actual USDC vs Aave debt is known.
 */
export type OpsScenario =
  | 'net_zero'            // net = 0; ops are a no-op, pipeline continues to nav/mark-done/phase2
  | 'net_mint_hl'         // net > 0, USDC-collateral perp (Hyperliquid)
  | 'redeem_hl'           // net < 0, HL path; tail determined reactively (falling/rising/balanced)
  | 'test_aave_loop';     // manual test only — deposit→borrow→swap→deposit→borrow; override-only

/**
 * Redeem tail variant — determined after steps 06 + 08 (close short + withdraw USDC from HL).
 * At that point contractUsdc holds the actual proceeds and can be compared to aaveDebt.
 */
export type RedeemTail =
  | 'falling'    // contractUsdc > aaveDebt: excess USDC → swap to asset (11b)
  | 'rising'     // contractUsdc < aaveDebt: asset shortfall → partial Aave withdraw + swap (11a)
  | 'balanced';  // contractUsdc ≈ aaveDebt: repay and withdraw directly

/**
 * Tolerance band for "balanced" detection.
 * If |contractUsdc - aaveDebt| / aaveDebt < BALANCED_TOLERANCE_BPS / 10000,
 * the path is treated as balanced (no swap needed).
 * Default: 10 bps = 0.1%.
 */
const BALANCED_TOLERANCE_BPS = 10n;

// ---------------------------------------------------------------------------
// Top-level classifier
// ---------------------------------------------------------------------------

/**
 * Determine the top-level ops scenario for this batch cycle.
 *
 * Inputs:
 *   net       — totalMintUSD - totalRedeemUSD (18 dec, signed)
 *   kashYield — contract instance to read activePerpExchange()
 *
 * Respects OPS_SCENARIO / --ops-scenario override from config.
 * The override can also specify a redeem tail directly (e.g. "redeem_hl_rising"),
 * in which case the top-level scenario is inferred as "redeem_hl" and
 * classifyRedeemTail() will return the forced tail.
 */
export async function classifyScenario(
  net: bigint,
  kashYield: ethers.Contract,
): Promise<OpsScenario> {
  const override = config.opsScenarioOverride?.toLowerCase();

  // Allow full override — map redeem sub-variants back to top-level
  if (override) {
    if (override === 'net_zero') return 'net_zero';
    if (override === 'net_mint_hl') return 'net_mint_hl';
    if (
      override === 'redeem_hl' ||
      override === 'redeem_hl_falling' ||
      override === 'redeem_hl_rising' ||
      override === 'redeem_hl_balanced'
    ) return 'redeem_hl';
    if (override === 'test_aave_loop') return 'test_aave_loop';
  }

  if (net === 0n) return 'net_zero';

  if (net > 0n) {
    // Mint: verify active perp exchange
    let perpName = '';
    try {
      perpName = await kashYield.activePerpExchange();
    } catch { /* default to HL */ }
    if (perpName && perpName.toUpperCase() !== 'HL') {
      // Non-HL perp detected — log warning and fall back to HL path
      // (Aster / other scenarios are deferred per plan)
      console.warn(`   ⚠️  activePerpExchange="${perpName}" is not HL; running net_mint_hl anyway (Aster deferred)`);
    }
    return 'net_mint_hl';
  }

  // net < 0 → redeem
  return 'redeem_hl';
}

/**
 * Classify the redeem tail AFTER step 06 (close short) and step 08 (withdraw USDC from HL).
 * At this point ctx.contractUsdc reflects the actual USDC proceeds.
 *
 * The OPS_SCENARIO override can force a specific tail:
 *   OPS_SCENARIO=redeem_hl_falling  → 'falling'
 *   OPS_SCENARIO=redeem_hl_rising   → 'rising'
 *   OPS_SCENARIO=redeem_hl_balanced → 'balanced'
 */
export function classifyRedeemTail(ctx: OpsContext): RedeemTail {
  const override = config.opsScenarioOverride?.toLowerCase();
  if (override === 'redeem_hl_falling') return 'falling';
  if (override === 'redeem_hl_rising') return 'rising';
  if (override === 'redeem_hl_balanced') return 'balanced';

  const { contractUsdc, aaveDebt } = ctx;

  if (aaveDebt === 0n) {
    // No debt to repay — treat as balanced (just withdraw Aave collateral)
    return 'balanced';
  }

  const diff = contractUsdc > aaveDebt ? contractUsdc - aaveDebt : aaveDebt - contractUsdc;
  const toleranceUsdc = (aaveDebt * BALANCED_TOLERANCE_BPS) / 10000n;

  if (diff <= toleranceUsdc) return 'balanced';
  if (contractUsdc > aaveDebt) return 'falling';
  return 'rising';
}

// ---------------------------------------------------------------------------
// Scenario label helpers (for logging / dry-run)
// ---------------------------------------------------------------------------

export function scenarioLabel(scenario: OpsScenario): string {
  switch (scenario) {
    case 'net_zero': return 'net_zero (no-op)';
    case 'net_mint_hl': return 'net_mint_hl (deposit→borrow→HL→short)';
    case 'redeem_hl': return 'redeem_hl (close→withdraw→repay/swap→Aave)';
    case 'test_aave_loop': return 'test_aave_loop (deposit→borrow→swap→deposit→borrow)';
  }
}

export function tailLabel(tail: RedeemTail): string {
  switch (tail) {
    case 'falling': return 'falling price (USDC excess → swap to asset via 11b)';
    case 'rising': return 'rising price (USDC shortfall → partial Aave withdraw + swap via 11a)';
    case 'balanced': return 'balanced (repay → withdraw directly)';
  }
}
