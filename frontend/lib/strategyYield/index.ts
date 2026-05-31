export { AAVE_V3_POOL_ARBITRUM_ONE, readStrategyEnvMultipliers, strategyMultipliers } from './constants';
export { fetchAaveReserveApyPct, rayPerSecondToApyPct } from './aaveRates';
export { fetchHlFundingApyPct, hourlyFundingToApyPct } from './hlFunding';
export { computePaYield, formatApyPct, type PaYieldBreakdown } from './computePaYield';

export type StrategyYieldProduct = 'eth' | 'btc';

export type StrategyYieldResponse = {
  product: StrategyYieldProduct;
  paYieldPct: number;
  paYieldDisplay: string;
  hlFundingApyPct: number;
  aaveSupplyApyPct: number;
  aaveBorrowApyPct: number;
  breakdown: {
    hlLegPct: number;
    aaveBorrowLegPct: number;
    aaveSupplyLegPct: number;
  };
  multipliers: {
    shortMult: number;
    debtMult: number;
    collateralMult: number;
    ltvPct: number;
    shortLeverage: number;
  };
  asOf: string;
};
