/**
 * setBtcPrice.ts
 *
 * Updates the BTC price on all three mock contracts simultaneously:
 *   - MockChainlinkPriceFeed  (the on-chain oracle KashYieldBtc reads at Phase 1)
 *   - MockAaveV3              (drives collateral value and borrow capacity)
 *   - MockHyperliquid         (drives perp P&L on the open short)
 *
 * Usage:
 *   BTC_PRICE_USD=80000 npm run set:btc-price
 *   BTC_PRICE_USD=45000 npm run set:btc-price   # price drop scenario
 *
 * Required env (bot/.env):
 *   PRIVATE_KEY           - owner wallet
 *   BTC_PRICE_USD         - new BTC price in whole USD (e.g. 80000 for $80,000)
 *   AAVE_POOL_ADDRESS     - your deployed MockAaveV3 address
 *   HYPERLIQUID_ADDRESS   - your deployed MockHyperliquid address
 *
 * Optional env:
 *   BTC_ORACLE_ADDRESS    - MockChainlinkPriceFeed (default: 0xBfFE...d27, Arbitrum Sepolia)
 *   RPC_URL / ARBITRUM_SEPOLIA_RPC_URL
 */

import { ethers } from 'ethers';
import { config } from '../config';

// ─── Minimal ABIs ─────────────────────────────────────────────────────────────

const MOCK_CHAINLINK_ABI = [
  {
    name: 'setPrice',
    type: 'function',
    inputs: [{ name: '_newPrice', type: 'int256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    name: 'latestRoundData',
    type: 'function',
    inputs: [],
    outputs: [
      { name: 'roundId',         type: 'uint80'  },
      { name: 'answer',          type: 'int256'  },
      { name: 'startedAt',       type: 'uint256' },
      { name: 'updatedAt',       type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80'  },
    ],
    stateMutability: 'view',
  },
] as const;

const MOCK_AAVE_ABI = [
  {
    name: 'setBtcPrice',
    type: 'function',
    inputs: [{ name: '_newPrice', type: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    name: 'btcPriceInUsd',
    type: 'function',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
] as const;

const MOCK_HYPERLIQUID_ABI = [
  {
    name: 'setBtcPrice',
    type: 'function',
    inputs: [{ name: '_price', type: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    name: 'btcPriceUsd',
    type: 'function',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
] as const;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt8(raw: bigint): string  { return `$${(Number(raw) / 1e8).toLocaleString()}`; }
function fmt18(raw: bigint): string { return `$${Number(ethers.formatEther(raw)).toLocaleString()}`; }

async function main() {
  // ── 1. Validate inputs ────────────────────────────────────────────────────
  const priceStr = process.env.BTC_PRICE_USD;
  if (!priceStr || isNaN(Number(priceStr))) {
    throw new Error('Set BTC_PRICE_USD=<number> (e.g. BTC_PRICE_USD=80000 for $80,000).');
  }
  const priceUsd = Number(priceStr);
  if (priceUsd <= 0) throw new Error('BTC_PRICE_USD must be positive.');

  if (!config.privateKey) {
    throw new Error('Set PRIVATE_KEY in bot/.env.');
  }
  const privateKey = config.privateKey.startsWith('0x')
    ? config.privateKey
    : `0x${config.privateKey}`;

  const oracleAddr = process.env.BTC_ORACLE_ADDRESS || config.oracles.BTC;
  const aaveAddr   = process.env.AAVE_POOL_ADDRESS  || config.aavePoolAddress;
  const hlAddr     = process.env.HYPERLIQUID_ADDRESS || '';

  if (!ethers.isAddress(oracleAddr))
    throw new Error(`Invalid BTC_ORACLE_ADDRESS: ${oracleAddr}`);
  if (!aaveAddr || !ethers.isAddress(aaveAddr))
    throw new Error('Set AAVE_POOL_ADDRESS in bot/.env (your deployed MockAaveV3 address).');
  if (!hlAddr || !ethers.isAddress(hlAddr))
    throw new Error('Set HYPERLIQUID_ADDRESS in bot/.env (your deployed MockHyperliquid address).');

  // ── 2. Connect ────────────────────────────────────────────────────────────
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const signer   = new ethers.Wallet(privateKey, provider);

  const oracle = new ethers.Contract(oracleAddr, MOCK_CHAINLINK_ABI, signer);
  const aave   = new ethers.Contract(aaveAddr,   MOCK_AAVE_ABI,      signer);
  const hl     = new ethers.Contract(hlAddr,     MOCK_HYPERLIQUID_ABI, signer);

  console.log('\nSetting BTC price across all three mock contracts...');
  console.log(`  New price:       $${priceUsd.toLocaleString()}`);
  console.log(`  Signer:          ${signer.address}`);
  console.log(`  Oracle:          ${oracleAddr}`);
  console.log(`  MockAave:        ${aaveAddr}`);
  console.log(`  MockHyperliquid: ${hlAddr}`);
  console.log('');

  // ── 3. Read current prices ────────────────────────────────────────────────
  try {
    const [, oracleBefore] = await oracle.latestRoundData() as [bigint, bigint, bigint, bigint, bigint];
    const aaveBefore = await aave.btcPriceInUsd() as bigint;
    const hlBefore   = await hl.btcPriceUsd() as bigint;
    console.log('Current prices:');
    console.log(`  Oracle (8 dec):  ${fmt8(oracleBefore)}`);
    console.log(`  Aave (18 dec):   ${fmt18(aaveBefore)}`);
    console.log(`  Hyperliquid:     ${fmt18(hlBefore)}`);
    console.log('');
  } catch {
    console.warn('  (Could not read current prices — continuing anyway)\n');
  }

  // ── 4. Encode new prices ──────────────────────────────────────────────────
  // MockChainlinkPriceFeed uses 8 decimals  →  $80,000 = 8_000_000_000_000
  const oraclePrice = BigInt(Math.round(priceUsd * 1e8));
  // MockAaveV3 + MockHyperliquid use 18 decimals  →  $80,000 = 80000 * 10^18
  const price18 = ethers.parseEther(String(priceUsd));

  // ── 5. Send transactions ──────────────────────────────────────────────────
  console.log('Sending transactions...');

  const txOracle = await oracle.setPrice(oraclePrice) as ethers.TransactionResponse;
  console.log(`  [1/3] Oracle       setPrice(${oraclePrice})   tx: ${txOracle.hash}`);
  await txOracle.wait();
  console.log('        confirmed ✓');

  const txAave = await aave.setBtcPrice(price18) as ethers.TransactionResponse;
  console.log(`  [2/3] Aave         setBtcPrice(${price18})  tx: ${txAave.hash}`);
  await txAave.wait();
  console.log('        confirmed ✓');

  const txHl = await hl.setBtcPrice(price18) as ethers.TransactionResponse;
  console.log(`  [3/3] Hyperliquid  setBtcPrice(${price18})  tx: ${txHl.hash}`);
  await txHl.wait();
  console.log('        confirmed ✓');

  // ── 6. Verify ─────────────────────────────────────────────────────────────
  console.log('\nVerifying updated prices:');
  const [, oracleAfter] = await oracle.latestRoundData() as [bigint, bigint, bigint, bigint, bigint];
  const aaveAfter = await aave.btcPriceInUsd() as bigint;
  const hlAfter   = await hl.btcPriceUsd() as bigint;
  console.log(`  Oracle (8 dec):  ${fmt8(oracleAfter)}`);
  console.log(`  Aave (18 dec):   ${fmt18(aaveAfter)}`);
  console.log(`  Hyperliquid:     ${fmt18(hlAfter)}`);

  console.log(`\nDone. BTC price is now $${priceUsd.toLocaleString()} on all mock contracts.`);
  console.log('Next: run the bot batch or call processBatchPhase1 — it will use the new oracle price.');
}

main()
  .then(() => process.exit(0))
  .catch((err: Error) => {
    console.error('\nError:', err.message ?? err);
    process.exit(1);
  });
