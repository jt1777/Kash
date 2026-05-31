/** Aave V3 Pool — Arbitrum One (same as KashYield contracts). */
export const AAVE_V3_POOL_ARBITRUM_ONE =
  '0x794a61358D6845594F94dc1DB02A252b5b4814aD' as const;

export const HL_INFO_API =
  (typeof process !== 'undefined' && process.env.HYPERLIQUID_API_URL?.trim()) ||
  'https://api.hyperliquid.xyz/info';

export const ARBITRUM_ONE_RPC =
  (typeof process !== 'undefined' &&
    (process.env.ARBITRUM_RPC_URL?.trim() ||
      process.env.NEXT_PUBLIC_RPC_URL?.trim() ||
      process.env.RPC_URL?.trim())) ||
  'https://arb1.arbitrum.io/rpc';

/** Strategy leverage multipliers derived from LTV + short leverage (Aave loop book). */
export function strategyMultipliers(ltvPct = 70, shortLeverage = 1.7) {
  const ltv = ltvPct / 100;
  const collateralMult = 1 + ltv;
  const debtMult = collateralMult * ltv;
  return {
    ltvPct,
    shortLeverage,
    /** Aave collateral vs initial deposit (~1.7 @ 70% LTV loop). */
    collateralMult,
    /** Total USDC debt vs initial deposit (~1.19 @ 70% LTV loop). */
    debtMult,
    /** HL short notional vs initial deposit. */
    shortMult: shortLeverage,
  };
}

export function readStrategyEnvMultipliers() {
  const ltvRaw = process.env.NEXT_PUBLIC_BORROW_LTV_PCT ?? process.env.BORROW_LTV_PCT ?? '70';
  const levRaw = process.env.NEXT_PUBLIC_SHORT_LEVERAGE ?? process.env.SHORT_LEVERAGE ?? '1.7';
  const ltvPct = Number(ltvRaw);
  const shortLeverage = Number(levRaw);
  return strategyMultipliers(
    Number.isFinite(ltvPct) ? ltvPct : 70,
    Number.isFinite(shortLeverage) ? shortLeverage : 1.7,
  );
}
