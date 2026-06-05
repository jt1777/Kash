import { ethers } from 'ethers';

/** Compute minOut from a quoted amount and on-chain maxSwapSlippageBps. */
export function minOutFromQuote(quotedOut: bigint, slippageBps: bigint): bigint {
  if (quotedOut === 0n || slippageBps >= 10000n) return 0n;
  return (quotedOut * (10000n - slippageBps)) / 10000n;
}

/** Fallback quote from Chainlink-style asset price when no DEX quoter is wired. */
export function quoteUsdcFromAsset(assetAmount: bigint, priceUsd18: bigint, assetDecimals: bigint): bigint {
  return (assetAmount * priceUsd18) / (10n ** assetDecimals) / 10n ** 12n;
}

export function quoteAssetFromUsdc(usdcAmount: bigint, priceUsd18: bigint, assetDecimals: bigint): bigint {
  if (priceUsd18 === 0n) return 0n;
  return (usdcAmount * 10n ** 12n * 10n ** assetDecimals) / priceUsd18;
}

export async function resolveSwapMinOut(
  kashYield: ethers.Contract,
  direction: 'assetToUsdc' | 'usdcToAsset',
  amountIn: bigint,
  priceUsd18: bigint,
  assetDecimals: bigint,
  quotedOut?: bigint,
): Promise<bigint> {
  const slippageBps = BigInt((await kashYield.maxSwapSlippageBps()).toString());
  const quote = quotedOut ?? (direction === 'assetToUsdc'
    ? quoteUsdcFromAsset(amountIn, priceUsd18, assetDecimals)
    : quoteAssetFromUsdc(amountIn, priceUsd18, assetDecimals));
  return minOutFromQuote(quote, slippageBps);
}
