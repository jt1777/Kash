import { HL_INFO_API } from './constants';

const HOURS_PER_YEAR = 8760;

/** Compound hourly HL funding rate to annualized APY (%). Positive = longs pay shorts. */
export function hourlyFundingToApyPct(hourlyRate: number): number {
  if (!Number.isFinite(hourlyRate)) return 0;
  return (Math.pow(1 + hourlyRate, HOURS_PER_YEAR) - 1) * 100;
}

type HlMetaUniverse = { name: string };
type HlAssetCtx = { funding?: string };

/**
 * Current hourly funding rate for a perp symbol (e.g. BTC, ETH) from HL info API.
 * Returns annualized APY % (short receives when funding is positive).
 */
export async function fetchHlFundingApyPct(
  symbol: 'BTC' | 'ETH',
  apiUrl = HL_INFO_API,
): Promise<number> {
  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
    next: { revalidate: 60 },
  });

  if (!res.ok) {
    throw new Error(`Hyperliquid info API HTTP ${res.status}`);
  }

  const json = (await res.json()) as [ { universe: HlMetaUniverse[] }, HlAssetCtx[] ];
  const [meta, ctxs] = json;
  if (!meta?.universe?.length || !Array.isArray(ctxs)) {
    throw new Error('Unexpected Hyperliquid metaAndAssetCtxs response');
  }

  const idx = meta.universe.findIndex((u) => u.name.toUpperCase() === symbol);
  if (idx < 0 || !ctxs[idx]?.funding) {
    throw new Error(`Hyperliquid funding not found for ${symbol}`);
  }

  const hourly = parseFloat(ctxs[idx].funding!);
  if (!Number.isFinite(hourly)) {
    throw new Error(`Invalid Hyperliquid funding for ${symbol}`);
  }

  return hourlyFundingToApyPct(hourly);
}
