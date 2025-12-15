// Deployed contract addresses on Arbitrum Sepolia
export const CONTRACTS = {
  kashYield: "0xc4aF7357c36DE37da8183ACeebe8519d4cd1e310" as `0x${string}`,
  kashToken: "0xb6a74Fb6Bb240e754237982F1943cAd77361d554" as `0x${string}`,
  mockAave: "0x1Fbe5029cC02e7bF88AB8d0082272655399379E8" as `0x${string}`,
  mockHyperliquid: "0x71194656990EB0A8501126d0c5f7F3daB29628b1" as `0x${string}`,
  tokens: {
    weth: "0x89c8C8AD33c4a9539361a2Cf1A908C4300F258D9" as `0x${string}`,
    wbtc: "0x4D8b720b94D341F54df948696747B05998c5FbD5" as `0x${string}`,
    usdt: "0x833EdA586220B1d0C25034E9bAb5ed4B4a5769a1" as `0x${string}`,
    usdc: "0x15BB91b9e63EA29863678B1dcBcB01dE31bD8Ab5" as `0x${string}`,
  },
  oracles: {
    ethUsd: "0x1AdF01abD96C11AEE2f20a41a03fAD11b3D8d2b4" as `0x${string}`,
    btcUsd: "0xBfFE5FE928F9597E2A21Ba8f2cDE7D2D10C09d27" as `0x${string}`,
    usdcUsd: "0xed45CBB45d34F53bf14C70e6FC2711bDd6454E76" as `0x${string}`,
    usdtUsd: "0x78a59DD416d0CE4AbfD2e27BFd2f6bFdceC446e3" as `0x${string}`,
  },
} as const;

export const ARBITRUM_SEPOLIA_CHAIN_ID = 421614;
