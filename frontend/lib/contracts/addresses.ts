// Deployed contract addresses on Arbitrum Sepolia
export const CONTRACTS = {
  kashYield: "0x4C3910E93aB0c5983c6DEE003749485E525E5Db7" as `0x${string}`,
  kashToken: "0x3461e725Fb77ead9a4FD22A10e0f0c9373156297" as `0x${string}`,
  mockAave: "0x1Fbe5029cC02e7bF88AB8d0082272655399379E8" as `0x${string}`,
  mockHyperliquid: "0x71194656990EB0A8501126d0c5f7F3daB29628b1" as `0x${string}`,
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
