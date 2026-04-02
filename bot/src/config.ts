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

// Load .env - override: false so shell env vars (e.g. KASH_YIELD_ADDRESS) take precedence
const envResult = dotenvConfig({ path: envPath, override: false });

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

export type Product = 'eth' | 'btc';

export const config = {
  // Blockchain
  rpcUrl: getRpcUrl(),
  chainId: parseInt(process.env.CHAIN_ID || '421614'),
  privateKey: process.env.PRIVATE_KEY || '',

  // Product: eth (KashYieldETH) or btc (KashYieldBtc)
  product: ((process.env.PRODUCT || 'eth').toLowerCase() === 'btc' ? 'btc' : 'eth') as Product,

  // Contracts - resolved from product-specific vars (KASH_YIELD_ETH_ADDRESS / KASH_YIELD_BTC_ADDRESS) or legacy KASH_YIELD_ADDRESS
  get kashYieldAddress(): string {
    const product = this.product;
    if (product === 'btc') {
      return process.env.KASH_YIELD_BTC_ADDRESS || process.env.KASH_YIELD_ADDRESS || '';
    }
    return process.env.KASH_YIELD_ETH_ADDRESS || process.env.KASH_YIELD_ADDRESS || '';
  },
  get kashTokenAddress(): string {
    const product = this.product;
    if (product === 'btc') {
      return process.env.KASH_TOKEN_BTC || process.env.KASH_TOKEN_ADDRESS || '';
    }
    return process.env.KASH_TOKEN_ETH || process.env.KASH_TOKEN_ADDRESS || '';
  },

  // Token Addresses (Arbitrum Sepolia)
  tokens: {
    ETH: '0x0000000000000000000000000000000000000000',
    WETH: process.env.WETH_ADDRESS || '0x89c8C8AD33c4a9539361a2Cf1A908C4300F258D9',
    WBTC: process.env.WBTC_ADDRESS || '0x4D8b720b94D341F54df948696747B05998c5FbD5',
    USDT: process.env.USDT_ADDRESS || '0x833EdA586220B1d0C25034E9bAb5ed4B4a5769a1',
    USDC: process.env.USDC_ADDRESS || '0x15BB91b9e63EA29863678B1dcBcB01dE31bD8Ab5',
  },

  // Aave V3 Pool (Arbitrum Sepolia)
  aavePoolAddress: process.env.AAVE_POOL_ADDRESS || '0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff',

  /** USDC address for Aave borrow/repay. When using MockAave, set to MockUSDC address. */
  aaveUsdcAddress: process.env.AAVE_USDC_ADDRESS || process.env.USDC_ADDRESS || '0x15BB91b9e63EA29863678B1dcBcB01dE31bD8Ab5',

  // Aave user address (defaults to kashYieldAddress if not set - for separate vault scenarios)
  aaveUserAddress: process.env.AAVE_USER_ADDRESS || '',

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
  /** When false, exit immediately if not in processing window instead of waiting */
  waitForProcessingWindow: process.env.WAIT_FOR_PROCESSING_WINDOW !== 'false',
  /** When true, skip the processing-window check so the bot runs batch logic anytime (for testing; contract may still revert if it enforces the window) */
  skipProcessingWindowCheck: process.env.SKIP_PROCESSING_WINDOW_CHECK === 'true',
  /** Batch flow step: full (all 5) | phase1 | ops | nav | mark-done | phase2. Also hl | aave for ops sub-step only. */
  batchStep: (() => {
    const arg = process.argv.find((a) => a.startsWith('--step='));
    const raw = arg ? arg.split('=')[1] : process.env.BATCH_STEP;
    const step = (raw || 'full').toLowerCase();
    const stepMap: Record<string, string> = {
      '1': 'phase1', '2': 'ops', '3': 'nav', '4': 'mark-done', '5': 'phase2',
      phase1: 'phase1', ops: 'ops', nav: 'nav', 'mark-done': 'mark-done', phase2: 'phase2',
      hl: 'hl', aave: 'aave', full: 'full',
    };
    return (stepMap[step] || 'full') as 'full' | 'phase1' | 'ops' | 'nav' | 'mark-done' | 'phase2' | 'hl' | 'aave';
  })(),
  /** When set, run on this batch cycle only (ignore auto-selection). Use --batch=N or BATCH_CYCLE=N. */
  batchCycleOverride: (() => {
    const arg = process.argv.find((a) => a.startsWith('--batch='));
    const raw = arg ? arg.split('=')[1] : process.env.BATCH_CYCLE;
    if (raw === undefined || raw === '') return null;
    const n = parseInt(raw, 10);
    return Number.isNaN(n) || n < 0 ? null : BigInt(n);
  })(),
  /** When true, allow running steps on an already-processed batch (e.g. --step=ops to fix HL/Aave state). Use --allow-processed or ALLOW_PROCESSED_BATCH=true. Only ops (and hl/aave) are allowed on processed batches. */
  allowProcessedBatch: process.argv.includes('--allow-processed') || process.env.ALLOW_PROCESSED_BATCH === 'true',
  /**
   * Pre-computed NAV to use when running individual steps (--step=ops or --step=nav).
   * Normally the full batch run computes this before ops and threads it through automatically.
   * When stepping through manually, pass the value logged as "NAV locked for this batch" so
   * the withdrawal sizing and updateNAV call use the pre-ops snapshot rather than a
   * post-ops recalculation.  Use --locked-nav=<18-decimal bigint> or LOCKED_NAV=<value>.
   * Example: --locked-nav=1050000000000000000  (= $1.05 per KASH, 18 decimals)
   */
  lockedNav: (() => {
    const arg = process.argv.find((a) => a.startsWith('--locked-nav='));
    const raw = arg ? arg.split('=')[1] : process.env.LOCKED_NAV;
    if (!raw || raw === '') return null;
    try { return BigInt(raw); } catch { return null; }
  })(),

  // Strategy allocation (NET_MINT / NET_REDEEM)
  // Override via .env: AAVE_DEPOSIT_PCT=100, BORROW_LTV_PCT=70, SHORT_LEVERAGE=1.7
  strategy: {
    /** % of net mint sent to Aave (100 = 100%) */
    aaveDepositPct: parseInt(process.env.AAVE_DEPOSIT_PCT || '100', 10),
    /** % of deposit value borrowed as USDC and sent to Hyperliquid (70 = 70% LTV) */
    borrowLtvPct: parseInt(process.env.BORROW_LTV_PCT || '70', 10),
    /** Short notional as multiple of net mint (1.7 = 1.7x) */
    shortLeverage: parseFloat(process.env.SHORT_LEVERAGE || '1.7'),
  },
};
