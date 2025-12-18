import { ethers } from 'ethers';
import { config } from '../config';
import { TokenPrice } from '../types';

// Chainlink Price Feed ABI (AggregatorV3Interface)
const CHAINLINK_ABI = [
  {
    inputs: [],
    name: 'latestRoundData',
    outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'decimals',
    outputs: [{ name: '', type: 'uint8' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

// Token decimals mapping
const TOKEN_DECIMALS: Record<string, number> = {
  [config.tokens.ETH]: 18,
  [config.tokens.WETH]: 18,
  [config.tokens.WBTC]: 8,
  [config.tokens.USDT]: 6,
  [config.tokens.USDC]: 6,
};

/**
 * Get token price from Chainlink oracle
 * @param tokenAddress Token address (use ETH_ADDRESS for ETH)
 * @param provider Ethers provider
 * @returns Token price in USD with 18 decimals
 */
export async function getTokenPrice(
  tokenAddress: string,
  provider: ethers.Provider
): Promise<TokenPrice> {
  // Map token to oracle address
  let oracleAddress: string;
  
  if (tokenAddress === config.tokens.ETH || tokenAddress === config.tokens.WETH) {
    oracleAddress = config.oracles.ETH;
  } else if (tokenAddress === config.tokens.WBTC) {
    oracleAddress = config.oracles.BTC;
  } else if (tokenAddress === config.tokens.USDT) {
    oracleAddress = config.oracles.USDT;
  } else if (tokenAddress === config.tokens.USDC) {
    oracleAddress = config.oracles.USDC;
  } else {
    throw new Error(`No oracle configured for token: ${tokenAddress}`);
  }

  // Verify oracle exists
  const code = await provider.getCode(oracleAddress);
  if (code === '0x') {
    throw new Error(`Oracle does not exist at address ${oracleAddress} on this network`);
  }

  const oracle = new ethers.Contract(oracleAddress, CHAINLINK_ABI, provider);
  
  // Get price data with error handling
  let roundData, decimals;
  try {
    [roundData, decimals] = await Promise.all([
      oracle.latestRoundData(),
      oracle.decimals(),
    ]);
  } catch (error: any) {
    if (error.code === 'BAD_DATA' || error.value === '0x') {
      throw new Error(
        `Oracle at ${oracleAddress} returned no data. ` +
        `This usually means:\n` +
        `  1. The oracle address is incorrect for this network\n` +
        `  2. The oracle is not deployed on this network\n` +
        `  3. The oracle contract doesn't have latestRoundData() function\n\n` +
        `Oracle address: ${oracleAddress}`
      );
    }
    throw error;
  }

  const price = BigInt(roundData.answer.toString());
  const priceDecimals = Number(decimals);
  const tokenDecimals = TOKEN_DECIMALS[tokenAddress] || 18;

  // Convert to 18 decimals
  // price (8 decimals) -> price (18 decimals)
  const price18Decimals = price * 10n ** BigInt(18 - priceDecimals);

  return {
    address: tokenAddress,
    price: price18Decimals,
    decimals: tokenDecimals,
  };
}

/**
 * Calculate USD value of a token amount
 * @param tokenAddress Token address
 * @param amount Token amount (in token's native decimals)
 * @param provider Ethers provider
 * @returns USD value with 18 decimals
 */
export async function calculateUSDValue(
  tokenAddress: string,
  amount: bigint,
  provider: ethers.Provider
): Promise<bigint> {
  if (amount === 0n) return 0n;

  const tokenPrice = await getTokenPrice(tokenAddress, provider);
  
  // Convert amount to 18 decimals, then multiply by price (already 18 decimals)
  const amount18Decimals = amount * 10n ** BigInt(18 - tokenPrice.decimals);
  const usdValue = (amount18Decimals * tokenPrice.price) / 10n ** 18n;

  return usdValue;
}
