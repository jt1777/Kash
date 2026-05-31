import type { strategyMultipliers } from './constants';

export type StrategyMultipliers = ReturnType<typeof strategyMultipliers>;

export type PaYieldInputs = {
  hlFundingApyPct: number;
  aaveSupplyApyPct: number;
  aaveBorrowApyPct: number;
  multipliers: StrategyMultipliers;
};

export type PaYieldBreakdown = {
  hlLegPct: number;
  aaveBorrowLegPct: number;
  aaveSupplyLegPct: number;
  paYieldPct: number;
};

/**
 * P.A. Yield = HL funding × shortMult − Aave USDC borrow × debtMult + Aave supply × collateralMult
 * All inputs are annualized APY percentages.
 */
export function computePaYield(inputs: PaYieldInputs): PaYieldBreakdown {
  const { hlFundingApyPct, aaveSupplyApyPct, aaveBorrowApyPct, multipliers } = inputs;
  const { shortMult, debtMult, collateralMult } = multipliers;

  const hlLegPct = hlFundingApyPct * shortMult;
  const aaveBorrowLegPct = aaveBorrowApyPct * debtMult;
  const aaveSupplyLegPct = aaveSupplyApyPct * collateralMult;
  const paYieldPct = hlLegPct - aaveBorrowLegPct + aaveSupplyLegPct;

  return { hlLegPct, aaveBorrowLegPct, aaveSupplyLegPct, paYieldPct };
}

export function formatApyPct(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '—';
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(digits)}%`;
}
