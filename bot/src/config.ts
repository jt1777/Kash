import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'path';
import { existsSync } from 'fs';

// Load .env file explicitly from bot directory
// When running from dist/, __dirname will be dist/, so we go up one level to bot/
const envPath = resolve(__dirname, '..', '.env');
const fs = require('fs');

// Debug: Check if file exists
if (fs.existsSync(envPath)) {
  console.log(`📁 Found .env file at: ${envPath}`);
} else {
  console.warn(`⚠️  .env file not found at: ${envPath}`);
  // Try current working directory
  const cwdEnvPath = resolve(process.cwd(), '.env');
  if (fs.existsSync(cwdEnvPath)) {
    console.log(`📁 Found .env file at: ${cwdEnvPath}`);
  }
}

// Load .env - dotenv by default loads from process.cwd(), so we explicitly set path
const envResult = dotenvConfig({ path: envPath, override: true });

// Debug logging
if (envResult.error) {
  console.warn(`⚠️  Warning: Could not load .env file: ${envResult.error.message}`);
} else {
  console.log(`✅ Loaded .env from: ${envPath}`);
}

// Debug: Log which RPC URL variables are set (after loading)
console.log(`🔍 ARBITRUM_SEPOLIA_RPC_URL: ${process.env.ARBITRUM_SEPOLIA_RPC_URL ? 'SET ✓' : 'NOT SET ✗'}`);
console.log(`🔍 RPC_URL: ${process.env.RPC_URL ? 'SET ✓' : 'NOT SET ✗'}`);

// Determine RPC URL with priority: ARBITRUM_SEPOLIA_RPC_URL > RPC_URL > default
const getRpcUrl = (): string => {
  if (process.env.ARBITRUM_SEPOLIA_RPC_URL) {
    return process.env.ARBITRUM_SEPOLIA_RPC_URL;
  }
  if (process.env.RPC_URL) {
    return process.env.RPC_URL;
  }
  return 'https://sepolia-rollup.arbitrum.io/rpc';
};

export const config = {
  // Blockchain
  // Prioritize ARBITRUM_SEPOLIA_RPC_URL if set, then RPC_URL, then default to Sepolia
  rpcUrl: getRpcUrl(),
  chainId: parseInt(process.env.CHAIN_ID || '421614'), // Arbitrum Sepolia chain ID
  privateKey: process.env.PRIVATE_KEY || '',

  // Contracts
  kashYieldAddress: process.env.KASH_YIELD_ADDRESS || '',
  kashTokenAddress: process.env.KASH_TOKEN_ADDRESS || '',

  // Token Addresses (Arbitrum Sepolia)
  tokens: {
    ETH: '0x0000000000000000000000000000000000000000',
    WETH: process.env.WETH_ADDRESS || '0x89c8C8AD33c4a9539361a2Cf1A908C4300F258D9',
    WBTC: process.env.WBTC_ADDRESS || '0x4D8b720b94D341F54df948696747B05998c5FbD5',
    USDT: process.env.USDT_ADDRESS || '0x833EdA586220B1d0C25034E9bAb5ed4B4a5769a1',
    USDC: process.env.USDC_ADDRESS || '0x15BB91b9e63EA29863678B1dcBcB01dE31bD8Ab5',
  },

  // Chainlink Oracles (Arbitrum Sepolia)
  // Can be overridden via environment variables
  oracles: {
    ETH: process.env.ETH_ORACLE_ADDRESS || '0x1AdF01abD96C11AEE2f20a41a03fAD11b3D8d2b4', // Arbitrum Sepolia ETH/USD
    BTC: process.env.BTC_ORACLE_ADDRESS || '0xBfFE5FE928F9597E2A21Ba8f2cDE7D2D10C09d27', // Arbitrum Sepolia BTC/USD
    USDT: process.env.USDT_ORACLE_ADDRESS || '0x78a59DD416d0CE4AbfD2e27BFd2f6bFdceC446e3', // Arbitrum Sepolia USDT/USD
    USDC: process.env.USDC_ORACLE_ADDRESS || '0xed45CBB45d34F53bf14C70e6FC2711bDd6454E76', // Arbitrum Sepolia USDC/USD
  },

  // Configuration
  batchProcessingTime: process.env.BATCH_PROCESSING_TIME || '23:50',
  logLevel: process.env.LOG_LEVEL || 'info',
};
