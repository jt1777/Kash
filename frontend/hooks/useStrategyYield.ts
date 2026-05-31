'use client';

import { useQuery } from '@tanstack/react-query';
import type { Address } from 'viem';
import { CONTRACTS } from '@/lib/contracts/addresses';
import {
  computePaYield,
  fetchAaveReserveApyPct,
  fetchHlFundingApyPct,
  formatApyPct,
  readStrategyEnvMultipliers,
  type StrategyYieldProduct,
  type StrategyYieldResponse,
} from '@/lib/strategyYield';

async function loadStrategyYield(product: StrategyYieldProduct): Promise<StrategyYieldResponse> {
  const multipliers = readStrategyEnvMultipliers();
  const collateralAsset = (product === 'btc' ? CONTRACTS.tokens.wbtc : CONTRACTS.tokens.weth) as Address;
  const usdcAsset = CONTRACTS.tokens.usdc as Address;
  const hlSymbol = product === 'btc' ? 'BTC' : 'ETH';

  const [hlFundingApyPct, collateralRates, usdcRates] = await Promise.all([
    fetchHlFundingApyPct(hlSymbol),
    fetchAaveReserveApyPct(collateralAsset),
    fetchAaveReserveApyPct(usdcAsset),
  ]);

  const breakdown = computePaYield({
    hlFundingApyPct,
    aaveSupplyApyPct: collateralRates.supplyApyPct,
    aaveBorrowApyPct: usdcRates.borrowApyPct,
    multipliers,
  });

  return {
    product,
    paYieldPct: breakdown.paYieldPct,
    paYieldDisplay: formatApyPct(breakdown.paYieldPct),
    hlFundingApyPct,
    aaveSupplyApyPct: collateralRates.supplyApyPct,
    aaveBorrowApyPct: usdcRates.borrowApyPct,
    breakdown: {
      hlLegPct: breakdown.hlLegPct,
      aaveBorrowLegPct: breakdown.aaveBorrowLegPct,
      aaveSupplyLegPct: breakdown.aaveSupplyLegPct,
    },
    multipliers: {
      shortMult: multipliers.shortMult,
      debtMult: multipliers.debtMult,
      collateralMult: multipliers.collateralMult,
      ltvPct: multipliers.ltvPct,
      shortLeverage: multipliers.shortLeverage,
    },
    asOf: new Date().toISOString(),
  };
}

export function useStrategyYield(product: StrategyYieldProduct) {
  return useQuery({
    queryKey: ['strategy-yield', product],
    queryFn: () => loadStrategyYield(product),
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: 2,
  });
}
