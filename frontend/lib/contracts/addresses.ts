// Deployed contract addresses on Arbitrum Sepolia
// Override with .env.local when you redeploy (e.g. NEXT_PUBLIC_KASH_YIELD_BTC, NEXT_PUBLIC_KASH_TOKEN_BTC, NEXT_PUBLIC_MOCK_WBTC)
function addr(envKey: string, fallback: string): `0x${string}` {
  const raw = typeof process !== 'undefined' ? process.env?.[envKey]?.trim?.() : undefined;
  return (raw && raw.startsWith('0x') ? raw : fallback) as `0x${string}`;
}

export const CONTRACTS = {
  // ETH product
  kashYieldEth: addr('NEXT_PUBLIC_KASH_YIELD_ETH', "0xf78854a9B5D28DdB1B35a60553e22481fE87d759"),
  kashTokenEth: addr('NEXT_PUBLIC_KASH_TOKEN_ETH', "0x0d590B388C3e01201852d623A5d7692ada376160"),
  // BTC product (KashYieldBtc + MockAave) — update these or set env when you redeploy
  kashYieldBtc: addr('NEXT_PUBLIC_KASH_YIELD_BTC', "0x059EC0767854d5e699508A8B57F21d5b3E63CB07"),
  kashTokenBtc: addr('NEXT_PUBLIC_KASH_TOKEN_BTC', "0x6124E335755C03C504FDb8abC7C4146b519E6b29"),
  mockWbtc: addr('NEXT_PUBLIC_MOCK_WBTC', "0xeC5Bd373D1808F06Ae849FE5227859a8E3D3FE12"),
  tokens: {
    weth: "0x89c8C8AD33c4a9539361a2Cf1A908C4300F258D9" as `0x${string}`,
    wbtc: "0x4D8b720b94D341F54df948696747B05998c5FbD5" as `0x${string}`,
    usdt: "0x833EdA586220B1d0C25034E9bAb5ed4B4a5769a1" as `0x${string}`,
    usdc: "0x15BB91b9e63EA29863678B1dcBcB01dE31bD8Ab5" as `0x${string}`,
  },
  oracles: {
    ethUsd: "0x2d3bBa5e0A9Fd8EAa45Dcf71A2389b7C12005b1f" as `0x${string}`, // Arbitrum Sepolia ETH/USD (real Chainlink)
    btcUsd: "0xBfFE5FE928F9597E2A21Ba8f2cDE7D2D10C09d27" as `0x${string}`, // MOCK BTC/USD (hardcoded $60k - no real feed on Arbitrum Sepolia)
    usdcUsd: "0xed45CBB45d34F53bf14C70e6FC2711bDd6454E76" as `0x${string}`, // Arbitrum Sepolia USDC/USD (real Chainlink)
    usdtUsd: "0x78a59DD416d0CE4AbfD2e27BFd2f6bFdceC446e3" as `0x${string}`, // Arbitrum Sepolia USDT/USD (real Chainlink)
  },
} as const;

export const ARBITRUM_SEPOLIA_CHAIN_ID = 421614;
export const ARBITRUM_SEPOLIA_BLOCK_EXPLORER = 'https://sepolia.arbiscan.io';
export const HARDHAT_CHAIN_ID = 31337;

export const hasBtcProduct = (): boolean => true;
