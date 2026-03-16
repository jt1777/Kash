require("@nomicfoundation/hardhat-toolbox");
const path = require("path");

// Load .env from project root so verify/scripts see ARBISCAN_API_KEY etc.
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
      viaIR: true
    }
  },
  networks: {
    // Local Hardhat network
    hardhat: {
      chainId: 31337
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
  
  // Etherscan verification
  // Note: Arbiscan V1 URLs used here; hardhat-verify 2.x does not send chainid required by Etherscan V2 API.
  // If you see deprecation errors, verify manually at https://sepolia.arbiscan.io/verifyContract or upgrade to Hardhat 3 + hardhat-verify 3.x.
  etherscan: {
    apiKey: {
      arbitrumSepolia: process.env.ARBISCAN_API_KEY || process.env.ETHERSCAN_API_KEY || "",
      arbitrumOne: process.env.ARBISCAN_API_KEY || process.env.ETHERSCAN_API_KEY || ""
    },
    customChains: [
      {
        network: "arbitrumSepolia",
        chainId: 421614,
        urls: {
          apiURL: "https://api-sepolia.arbiscan.io/api",
          browserURL: "https://sepolia.arbiscan.io"
        }
      },
      {
        network: "arbitrumOne",
        chainId: 42161,
        urls: {
          apiURL: "https://api.arbiscan.io/api",
          browserURL: "https://arbiscan.io"
        }
      }
    ]
  },
  
  // Gas reporter
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
    outputFile: "gasReporterOutput.json",
    noColors: true
  }
};
