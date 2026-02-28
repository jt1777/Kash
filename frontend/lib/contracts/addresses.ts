// Deployed contract addresses on Arbitrum Sepolia (ETH product)
// BTC product (KashYieldBtc + MockAave): set via NEXT_PUBLIC_* env vars after running deploy-kashyieldbtc.js
const kashYieldBtcEnv = process.env.NEXT_PUBLIC_KASH_YIELD_BTC as string | undefined;
const kashTokenBtcEnv = process.env.NEXT_PUBLIC_KASH_TOKEN_BTC as string | undefined;
const mockWbtcEnv = process.env.NEXT_PUBLIC_MOCK_WBTC as string | undefined;

export const CONTRACTS = {
  kashYieldEth: "0xf78854a9B5D28DdB1B35a60553e22481fE87d759" as `0x${string}`,
  kashTokenEth: "0x0d590B388C3e01201852d623A5d7692ada376160" as `0x${string}`,
  // BTC product - only set when deployed
  kashYieldBtc: (kashYieldBtcEnv && kashYieldBtcEnv.startsWith('0x') ? kashYieldBtcEnv : null) as `0x${string}` | null,
  kashTokenBtc: (kashTokenBtcEnv && kashTokenBtcEnv.startsWith('0x') ? kashTokenBtcEnv : null) as `0x${string}` | null,
  mockWbtc: (mockWbtcEnv && mockWbtcEnv.startsWith('0x') ? mockWbtcEnv : null) as `0x${string}` | null,
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

export const hasBtcProduct = (): boolean =>
  !!(CONTRACTS.kashYieldBtc && CONTRACTS.kashTokenBtc && CONTRACTS.mockWbtc);
