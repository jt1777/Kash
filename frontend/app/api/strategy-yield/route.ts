import { NextRequest, NextResponse } from 'next/server';
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

export const dynamic = 'force-dynamic';
export const revalidate = 60;

function parseProduct(raw: string | null): StrategyYieldProduct | null {
  const p = raw?.toLowerCase();
  if (p === 'eth' || p === 'btc') return p;
  return null;
}

export async function GET(request: NextRequest) {
  const product = parseProduct(request.nextUrl.searchParams.get('product'));
  if (!product) {
    return NextResponse.json({ error: 'Invalid product (use eth or btc)' }, { status: 400 });
  }

  const multipliers = readStrategyEnvMultipliers();
  const collateralAsset = (product === 'btc' ? CONTRACTS.tokens.wbtc : CONTRACTS.tokens.weth) as Address;
  const usdcAsset = CONTRACTS.tokens.usdc as Address;
  const hlSymbol = product === 'btc' ? 'BTC' : 'ETH';

  try {
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

    const body: StrategyYieldResponse = {
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

    return NextResponse.json(body, {
      headers: {
        'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120',
      },
    });
  } catch (e) {
    console.error('strategy-yield API error:', e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to fetch strategy yield' },
      { status: 502 },
    );
  }
}
