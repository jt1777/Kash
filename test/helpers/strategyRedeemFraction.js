/**
 * Keep in sync with kash-ops bot/src/batch/strategyRedeemFraction.ts (pure helpers only).
 */

const WAD = 10n ** 18n;

function mintKashEstimateFromBatchMintUsd(totalMintUSD, feeBps, nav) {
  if (nav === 0n || totalMintUSD === 0n) return 0n;
  const afterFee = (totalMintUSD * (10000n - feeBps)) / 10000n;
  return (afterFee * WAD) / nav;
}

function strategyRedeemFractionPure(args) {
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

module.exports = { WAD, mintKashEstimateFromBatchMintUsd, strategyRedeemFractionPure };
