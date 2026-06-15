require("@nomicfoundation/hardhat-toolbox");
const path = require("path");

// Load .env from project root so verify/scripts see ETHERSCAN_API_KEY etc.
const rootEnv = path.join(__dirname, ".env");
require("dotenv").config({ path: rootEnv });

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: {
        enabled: true,
        runs: 1
      },
      viaIR: true,
      // Omit CBOR IPFS hash from bytecode tail — shaves ~50 bytes (helps EIP-170).
      metadata: { bytecodeHash: "none" }
    }
  },
  networks: {
    // Local Hardhat network.
    // When ARBITRUM_MAINNET_RPC_URL is set, Hardhat forks Arbitrum One and caches
    // all RPC responses for the pinned block in .cache/hardhat-network-fork/.
    // Pin to a specific block with FORK_BLOCK_NUMBER= in .env to avoid transient
    // -32603 errors and to make re-runs fast (cache hits).
    hardhat: {
      chainId: 31337,
      allowUnlimitedContractSize: true,
      forking: process.env.ARBITRUM_MAINNET_RPC_URL ? {
        url: process.env.ARBITRUM_MAINNET_RPC_URL,
        blockNumber: process.env.FORK_BLOCK_NUMBER
          ? parseInt(process.env.FORK_BLOCK_NUMBER)
          : 440_000_000, // ~3 weeks before Apr 2026; well-archived, fast cache hits
      } : undefined,
    },
    
    // Arbitrum Sepolia (Testnet)
    arbitrumSepolia: {
      url: process.env.ARBITRUM_SEPOLIA_RPC_URL || "https://sepolia-rollup.arbitrum.io/rpc",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      chainId: 421614,
      gasPrice: "auto"
    },
    
    // Arbitrum One (Mainnet) - for future use
    arbitrumOne: {
      url: process.env.ARBITRUM_ONE_RPC_URL || "https://arb1.arbitrum.io/rpc",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      chainId: 42161,
      gasPrice: "auto"
    }
  },
  
  // Etherscan verification (API v2)
  // Use a single key from https://etherscan.io/myapikey (works for Arbiscan + all Etherscan explorers).
  // Per-network apiKey maps + customChains api.arbiscan.io URLs force deprecated API v1.
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY || process.env.ARBISCAN_API_KEY || "",
  },
  
  // Gas reporter
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
    outputFile: "gasReporterOutput.json",
    noColors: true
  }
};
