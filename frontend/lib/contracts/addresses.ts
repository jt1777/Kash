// Deployed contract addresses on Arbitrum One (override with .env.local / next.config `env`).
// Must use NEXT_PUBLIC_ prefix for client-side exposure in Next.js.
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as `0x${string}`;

function addr(envKey: string, fallback?: string, secondaryKey?: string): `0x${string}` {
  const tryKey = (key: string): `0x${string}` | undefined => {
    const raw = typeof process !== 'undefined' ? process.env?.[key]?.trim?.() : undefined;
    if (raw && raw.startsWith('0x')) return raw as `0x${string}`;
    return undefined;
  };
  return (
    tryKey(envKey) ??
    (secondaryKey ? tryKey(secondaryKey) : undefined) ??
    (fallback ?? ZERO_ADDRESS)
  ) as `0x${string}`;
}

export const CONTRACTS = {
  // ETH: NEXT_PUBLIC_* for browser; KASH_* matches next.config.js `env` (single source in .env.local).
  kashYieldEth: addr(
    'NEXT_PUBLIC_KASH_YIELD_ETH_ADDRESS',
    '0x92c5833Deaac65a7aCB47867Cf009cAC1bF1dD5a',
    'KASH_YIELD_ETH_ADDRESS',
  ),
  kashTokenEth: addr('NEXT_PUBLIC_KASH_TOKEN_ETH', '0x8642483DcCE55270692aD559dCac7cf7eA0F9Bd9', 'KASH_TOKEN_ETH'),
  // BTC product (env key MOCK_WBTC is legacy; on mainnet this is canonical wBTC)
  kashYieldBtc: addr(
    'NEXT_PUBLIC_KASH_YIELD_BTC_ADDRESS',
    '0x307f81b91D0396f54a30499b8C75e019C66abA47',
    'KASH_YIELD_BTC_ADDRESS',
  ),
  kashTokenBtc: addr('NEXT_PUBLIC_KASH_TOKEN_BTC', '0xd7001987E7584D840F56719C77d876A7899bE3d3', 'KASH_TOKEN_BTC'),
  mockWbtc: addr('NEXT_PUBLIC_MOCK_WBTC', '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', 'MOCK_WBTC'),
  tokens: {
    weth: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1' as `0x${string}`,
    wbtc: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f' as `0x${string}`,
    usdt: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9' as `0x${string}`,
    usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' as `0x${string}`,
  },
  oracles: {
    ethUsd: '0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612' as `0x${string}`, // Chainlink ETH/USD (Arbitrum One)
    btcUsd: '0x6ce185860a4963106506C203335A2910413708e9' as `0x${string}`, // Chainlink BTC/USD (Arbitrum One)
    usdcUsd: '0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3' as `0x${string}`, // Chainlink USDC/USD (Arbitrum One)
    usdtUsd: '0x3C3E8DFEaCC9cBef7A41d2A1cD95D61Eaf7623Ca' as `0x${string}`, // Chainlink USDT/USD (Arbitrum One)
  },
} as const;

/** Arbitrum One */
export const ARBITRUM_ONE_CHAIN_ID = 42161;
export const ARBITRUM_ONE_BLOCK_EXPLORER = 'https://arbiscan.io';
export const HARDHAT_CHAIN_ID = 31337;

export const hasBtcProduct = (): boolean => true;
