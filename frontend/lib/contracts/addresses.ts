// Contract addresses — must use static process.env.NEXT_PUBLIC_* references below.
// Next.js only inlines env at build time for literal keys (process.env.FOO), not process.env[key].
// After changing .env.local or Vercel env, restart dev server or redeploy production.
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as `0x${string}`;

function pickAddr(
  ...candidates: (string | undefined)[]
): `0x${string}` {
  for (const c of candidates) {
    const raw = c?.trim();
    if (raw && raw.startsWith('0x')) return raw as `0x${string}`;
  }
  return ZERO_ADDRESS;
}

export const CONTRACTS = {
  kashYieldEth: pickAddr(
    process.env.NEXT_PUBLIC_KASH_YIELD_ETH_ADDRESS,
    process.env.KASH_YIELD_ETH_ADDRESS,
  ),
  kashTokenEth: pickAddr(
    process.env.NEXT_PUBLIC_KASH_TOKEN_ETH,
    process.env.KASH_TOKEN_ETH,
  ),
  kashYieldBtc: pickAddr(
    process.env.NEXT_PUBLIC_KASH_YIELD_BTC_ADDRESS,
    process.env.KASH_YIELD_BTC_ADDRESS,
  ),
  kashTokenBtc: pickAddr(
    process.env.NEXT_PUBLIC_KASH_TOKEN_BTC,
    process.env.KASH_TOKEN_BTC,
  ),
  mockWbtc: pickAddr(
    process.env.NEXT_PUBLIC_MOCK_WBTC,
    process.env.MOCK_WBTC,
    '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f',
  ),
  tokens: {
    weth: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1' as `0x${string}`,
    wbtc: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f' as `0x${string}`,
    usdt: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9' as `0x${string}`,
    usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' as `0x${string}`,
  },
  oracles: {
    ethUsd: '0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612' as `0x${string}`,
    btcUsd: '0x6ce185860a4963106506C203335A2910413708e9' as `0x${string}`,
    usdcUsd: '0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3' as `0x${string}`,
    usdtUsd: '0x3C3E8DFEaCC9cBef7A41d2A1cD95D61Eaf7623Ca' as `0x${string}`,
  },
} as const;

/** Arbitrum One */
export const ARBITRUM_ONE_CHAIN_ID = 42161;
export const ARBITRUM_ONE_BLOCK_EXPLORER = 'https://arbiscan.io';
export const HARDHAT_CHAIN_ID = 31337;

/** KashYield vaults with verified source on Arbiscan (#code tab). */
export const ARBISCAN_VERIFIED_KASH_YIELD = new Set<string>([
  CONTRACTS.kashYieldEth.toLowerCase(),
  CONTRACTS.kashYieldBtc.toLowerCase(),
]);

/** KASH ERC-20 tokens with verified source on Arbiscan (#code tab). */
export const ARBISCAN_VERIFIED_KASH_TOKEN = new Set<string>([
  CONTRACTS.kashTokenEth.toLowerCase(),
  CONTRACTS.kashTokenBtc.toLowerCase(),
]);

export function arbiscanAddressUrl(
  address: `0x${string}`,
  options?: { code?: boolean },
): string {
  const base = `${ARBITRUM_ONE_BLOCK_EXPLORER}/address/${address}`;
  return options?.code ? `${base}#code` : base;
}

export function isArbiscanVerifiedKashYield(address: `0x${string}`): boolean {
  return ARBISCAN_VERIFIED_KASH_YIELD.has(address.toLowerCase());
}

export function isArbiscanVerifiedKashToken(address: `0x${string}`): boolean {
  return ARBISCAN_VERIFIED_KASH_TOKEN.has(address.toLowerCase());
}

export function isConfiguredAddress(address: `0x${string}`): boolean {
  return address !== ZERO_ADDRESS && /^0x[0-9a-fA-F]{40}$/.test(address);
}

export const hasBtcProduct = (): boolean =>
  isConfiguredAddress(CONTRACTS.kashYieldBtc) && isConfiguredAddress(CONTRACTS.kashTokenBtc);

export const hasEthProduct = (): boolean =>
  isConfiguredAddress(CONTRACTS.kashYieldEth) && isConfiguredAddress(CONTRACTS.kashTokenEth);
