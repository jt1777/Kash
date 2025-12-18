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

  // Token Addresses (Arbitrum Mainnet)
  tokens: {
    ETH: '0x0000000000000000000000000000000000000000',
    WETH: process.env.WETH_ADDRESS || '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    WBTC: process.env.WBTC_ADDRESS || '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f',
    USDT: process.env.USDT_ADDRESS || '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
    USDC: process.env.USDC_ADDRESS || '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  },

  // Chainlink Oracles
  // Default to Arbitrum Sepolia testnet addresses
  // NOTE: BTC oracle is a MOCK (hardcoded $60k) - Chainlink doesn't provide BTC/USD on Arbitrum Sepolia
  // Can be overridden via environment variables
  oracles: {
    ETH: process.env.ETH_ORACLE_ADDRESS || '0x2d3bBa5e0A9Fd8EAa45Dcf71A2389b7C12005b1f', // Arbitrum Sepolia ETH/USD (real)
    BTC: process.env.BTC_ORACLE_ADDRESS || '0xBfFE5FE928F9597E2A21Ba8f2cDE7D2D10C09d27', // MOCK BTC/USD ($60k hardcoded)
    USDT: process.env.USDT_ORACLE_ADDRESS || '0x78a59DD416d0CE4AbfD2e27BFd2f6bFdceC446e3', // Arbitrum Sepolia USDT/USD (real)
    USDC: process.env.USDC_ORACLE_ADDRESS || '0xed45CBB45d34F53bf14C70e6FC2711bDd6454E76', // Arbitrum Sepolia USDC/USD (real)
  },

  // Configuration
  batchProcessingTime: process.env.BATCH_PROCESSING_TIME || '23:50',
  logLevel: process.env.LOG_LEVEL || 'info',
};
