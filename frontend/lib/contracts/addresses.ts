// Deployed contract addresses on Arbitrum Sepolia (ETH product)
export const CONTRACTS = {
  kashYieldEth: "0xDc41b0948D4B0515b7b03C14F1d618eb8b3e041D" as `0x${string}`,
  kashTokenEth: "0x568522AdeFa4E38ff96ce4a01751E938B4E18a27" as `0x${string}`,
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
