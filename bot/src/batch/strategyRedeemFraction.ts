/**
 * Pure helpers for strategy unwind fraction vs gross redeem fraction.
 * Gross: batchTotalRedeemKash / totalSupply (all redeemers).
 * Strategy: max(0, redeemKash - estimatedMintKash) / totalSupply when the batch has minters,
 * so incoming mints offset how much of the HL/Aave position must be unwound.
 */

const WAD = 10n ** 18n;

/** KASH that Phase 2 would mint for the batch, from batchTotalMintValueUSD at `nav` (Phase-1-style NAV). */
export function mintKashEstimateFromBatchMintUsd(totalMintUSD: bigint, feeBps: bigint, nav: bigint): bigint {
  if (nav === 0n || totalMintUSD === 0n) return 0n;
  const afterFee = (totalMintUSD * (10000n - feeBps)) / 10000n;
  return (afterFee * WAD) / nav;
}

/**
 * Fraction of existing KASH supply to unwind from HL/Aave (18 dec, 1e18 = 100%).
 * When there are no minters, equals gross redeem fraction.
 */
export function strategyRedeemFractionPure(args: {
  totalSupply: bigint;
  redeemKash: bigint;
  mintUsersCount: bigint;
  totalMintUSD: bigint;
  feeBps: bigint;
  nav: bigint;
}): bigint {
  const { totalSupply, redeemKash, mintUsersCount, totalMintUSD, feeBps, nav } = args;
  if (totalSupply === 0n) return WAD;
  if (redeemKash === 0n) return 0n;

  let gross = (redeemKash * WAD) / totalSupply;
  if (gross > WAD) gross = WAD;

  if (mintUsersCount === 0n || totalMintUSD === 0n) return gross;

  const mintKashEst = mintKashEstimateFromBatchMintUsd(totalMintUSD, feeBps, nav === 0n ? 1n : nav);
  const netRedeemKash = redeemKash > mintKashEst ? redeemKash - mintKashEst : 0n;
  let strategy = (netRedeemKash * WAD) / totalSupply;
  if (strategy > WAD) strategy = WAD;
  return strategy;
}
