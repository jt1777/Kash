/**
 * setAssetPrice.ts
 *
 * Updates asset prices across all mock contracts simultaneously:
 *   - MockChainlinkPriceFeed  (oracle the KashYield contract reads)
 *   - MockAaveV3              (drives collateral value and borrow capacity)
 *   - MockHyperliquid         (drives perp P&L on the open short/long)
 *   - MockSpotDex             (swap rates for USDC ↔ wBTC / USDC ↔ ETH)
 *
 * Set BTC_PRICE_USD, ETH_PRICE_USD, or both. At least one is required.
 *
 * Usage:
 *   BTC_PRICE_USD=45000 npm run set:asset-price
 *   ETH_PRICE_USD=3000  npm run set:asset-price
 *   BTC_PRICE_USD=45000 ETH_PRICE_USD=3000 npm run set:asset-price
 *
 * Required in bot/.env:
 *   PRIVATE_KEY
 *   AAVE_POOL_ADDRESS       — deployed MockAaveV3
 *   HYPERLIQUID_ADDRESS     — deployed MockHyperliquid
 *
 * Optional in bot/.env:
 *   BTC_ORACLE_ADDRESS      — MockChainlinkPriceFeed for BTC (falls back to config default)
 *   ETH_ORACLE_ADDRESS      — MockChainlinkPriceFeed for ETH (falls back to config default)
 *   MOCK_SPOT_DEX_ADDRESS   — if set, also updates MockSpotDex swap rates
 *   WBTC_ADDRESS            — required for BTC spot rates (falls back to config default)
 *   USDC_ADDRESS            — required for spot rates (falls back to config default)
 */

import { ethers } from 'ethers';
import { config } from '../config';

// ─── ABIs ─────────────────────────────────────────────────────────────────────

const CHAINLINK_ABI = [
  { name: 'setPrice',        type: 'function', inputs: [{ name: '_newPrice', type: 'int256'  }], outputs: [], stateMutability: 'nonpayable' },
  { name: 'latestRoundData', type: 'function', inputs: [], outputs: [
    { name: 'roundId',         type: 'uint80'  },
    { name: 'answer',          type: 'int256'  },
    { name: 'startedAt',       type: 'uint256' },
    { name: 'updatedAt',       type: 'uint256' },
    { name: 'answeredInRound', type: 'uint80'  },
  ], stateMutability: 'view' },
] as const;

const MOCK_AAVE_ABI = [
  { name: 'setBtcPrice', type: 'function', inputs: [{ name: '_newPrice', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { name: 'setEthPrice', type: 'function', inputs: [{ name: '_newPrice', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { name: 'btcPriceInUsd', type: 'function', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { name: 'ethPriceInUsd', type: 'function', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
] as const;

const MOCK_HL_ABI = [
  { name: 'setBtcPrice', type: 'function', inputs: [{ name: '_price', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { name: 'setEthPrice', type: 'function', inputs: [{ name: '_price', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { name: 'btcPriceUsd', type: 'function', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { name: 'ethPriceUsd', type: 'function', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
] as const;

const MOCK_SPOT_DEX_ABI = [
  { name: 'setBtcRates', type: 'function', inputs: [
    { name: 'wbtcAddress', type: 'address' },
    { name: 'usdcAddress', type: 'address' },
    { name: 'btcPriceUsd', type: 'uint256' },
  ], outputs: [], stateMutability: 'nonpayable' },
  { name: 'setEthRates', type: 'function', inputs: [
    { name: 'usdcAddress', type: 'address' },
    { name: 'ethPriceUsd', type: 'uint256' },
  ], outputs: [], stateMutability: 'nonpayable' },
] as const;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmt8  = (raw: bigint) => `$${(Number(raw) / 1e8).toLocaleString()}`;
const fmt18 = (raw: bigint) => `$${Number(ethers.formatEther(raw)).toLocaleString()}`;

async function main() {
  // ── 1. Validate inputs ────────────────────────────────────────────────────
  const btcPriceStr = process.env.BTC_PRICE_USD;
  const ethPriceStr = process.env.ETH_PRICE_USD;

  if (!btcPriceStr && !ethPriceStr) {
    throw new Error('Set BTC_PRICE_USD and/or ETH_PRICE_USD (e.g. BTC_PRICE_USD=45000 ETH_PRICE_USD=3000).');
  }

  const btcPriceUsd = btcPriceStr ? Number(btcPriceStr) : null;
  const ethPriceUsd = ethPriceStr ? Number(ethPriceStr) : null;

  if (btcPriceUsd !== null && (isNaN(btcPriceUsd) || btcPriceUsd <= 0))
    throw new Error('BTC_PRICE_USD must be a positive number.');
  if (ethPriceUsd !== null && (isNaN(ethPriceUsd) || ethPriceUsd <= 0))
    throw new Error('ETH_PRICE_USD must be a positive number.');

  if (!config.privateKey) throw new Error('Set PRIVATE_KEY in bot/.env.');
  const privateKey = config.privateKey.startsWith('0x') ? config.privateKey : `0x${config.privateKey}`;

  const aaveAddr      = process.env.AAVE_POOL_ADDRESS  || config.aavePoolAddress;
  const hlAddr        = process.env.HYPERLIQUID_ADDRESS || '';
  const spotDexAddr   = process.env.MOCK_SPOT_DEX_ADDRESS || '';
  const wbtcAddr      = process.env.WBTC_ADDRESS || config.tokens.WBTC;
  const usdcAddr      = process.env.USDC_ADDRESS || config.tokens.USDC;
  const btcOracleAddr = process.env.BTC_ORACLE_ADDRESS || config.oracles.BTC;
  const ethOracleAddr = process.env.ETH_ORACLE_ADDRESS || config.oracles.ETH;

  if (!aaveAddr || !ethers.isAddress(aaveAddr))
    throw new Error('Set AAVE_POOL_ADDRESS in bot/.env (your deployed MockAaveV3 address).');
  if (!hlAddr || !ethers.isAddress(hlAddr))
    throw new Error('Set HYPERLIQUID_ADDRESS in bot/.env (your deployed MockHyperliquid address).');

  // ── 2. Connect ────────────────────────────────────────────────────────────
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const signer   = new ethers.Wallet(privateKey, provider);

  const aave    = new ethers.Contract(aaveAddr, MOCK_AAVE_ABI, signer);
  const hl      = new ethers.Contract(hlAddr,   MOCK_HL_ABI,   signer);
  const spotDex = spotDexAddr && ethers.isAddress(spotDexAddr)
    ? new ethers.Contract(spotDexAddr, MOCK_SPOT_DEX_ABI, signer)
    : null;

  console.log('\nSetting prices across mock contracts...');
  console.log(`  Signer:          ${signer.address}`);
  if (btcPriceUsd) console.log(`  BTC price:       $${btcPriceUsd.toLocaleString()}`);
  if (ethPriceUsd) console.log(`  ETH price:       $${ethPriceUsd.toLocaleString()}`);
  console.log(`  MockAave:        ${aaveAddr}`);
  console.log(`  MockHyperliquid: ${hlAddr}`);
  if (btcPriceUsd) console.log(`  BTC oracle:      ${btcOracleAddr}`);
  if (ethPriceUsd) console.log(`  ETH oracle:      ${ethOracleAddr}`);
  if (spotDex)     console.log(`  MockSpotDex:     ${spotDexAddr}`);
  console.log('');

  let txCount = 0;

  // ── 3. BTC price updates ──────────────────────────────────────────────────
  if (btcPriceUsd !== null) {
    const oraclePrice8 = BigInt(Math.round(btcPriceUsd * 1e8));
    const price18      = ethers.parseEther(String(btcPriceUsd));

    const btcOracle = new ethers.Contract(btcOracleAddr, CHAINLINK_ABI, signer);

    console.log('── BTC ──────────────────────────────────────────────────');
    try {
      const [, before] = await btcOracle.latestRoundData() as [bigint, bigint, bigint, bigint, bigint];
      console.log(`  Oracle before:   ${fmt8(before)}`);
    } catch { /* ignore */ }

    const t1 = await btcOracle.setPrice(oraclePrice8) as ethers.TransactionResponse;
    console.log(`  [BTC 1/3] Oracle       setPrice   tx: ${t1.hash}`);
    await t1.wait(); console.log('             confirmed ✓');

    const t2 = await aave.setBtcPrice(price18) as ethers.TransactionResponse;
    console.log(`  [BTC 2/3] Aave         setBtcPrice tx: ${t2.hash}`);
    await t2.wait(); console.log('             confirmed ✓');

    const t3 = await hl.setBtcPrice(price18) as ethers.TransactionResponse;
    console.log(`  [BTC 3/3] Hyperliquid  setBtcPrice tx: ${t3.hash}`);
    await t3.wait(); console.log('             confirmed ✓');

    if (spotDex) {
      if (!wbtcAddr || !ethers.isAddress(wbtcAddr))
        throw new Error('Set WBTC_ADDRESS in bot/.env for MockSpotDex BTC rates.');
      if (!usdcAddr || !ethers.isAddress(usdcAddr))
        throw new Error('Set USDC_ADDRESS in bot/.env for MockSpotDex BTC rates.');
      const t4 = await spotDex.setBtcRates(wbtcAddr, usdcAddr, btcPriceUsd) as ethers.TransactionResponse;
      console.log(`  [BTC 4/4] MockSpotDex  setBtcRates tx: ${t4.hash}`);
      await t4.wait(); console.log('             confirmed ✓');
    }

    txCount += spotDex ? 4 : 3;
    console.log('');
  }

  // ── 4. ETH price updates ──────────────────────────────────────────────────
  if (ethPriceUsd !== null) {
    const oraclePrice8 = BigInt(Math.round(ethPriceUsd * 1e8));
    const price18      = ethers.parseEther(String(ethPriceUsd));

    const ethOracle = new ethers.Contract(ethOracleAddr, CHAINLINK_ABI, signer);

    console.log('── ETH ──────────────────────────────────────────────────');
    try {
      const [, before] = await ethOracle.latestRoundData() as [bigint, bigint, bigint, bigint, bigint];
      console.log(`  Oracle before:   ${fmt8(before)}`);
    } catch { /* ignore */ }

    const t1 = await ethOracle.setPrice(oraclePrice8) as ethers.TransactionResponse;
    console.log(`  [ETH 1/3] Oracle       setPrice    tx: ${t1.hash}`);
    await t1.wait(); console.log('             confirmed ✓');

    const t2 = await aave.setEthPrice(price18) as ethers.TransactionResponse;
    console.log(`  [ETH 2/3] Aave         setEthPrice tx: ${t2.hash}`);
    await t2.wait(); console.log('             confirmed ✓');

    const t3 = await hl.setEthPrice(price18) as ethers.TransactionResponse;
    console.log(`  [ETH 3/3] Hyperliquid  setEthPrice tx: ${t3.hash}`);
    await t3.wait(); console.log('             confirmed ✓');

    if (spotDex) {
      if (!usdcAddr || !ethers.isAddress(usdcAddr))
        throw new Error('Set USDC_ADDRESS in bot/.env for MockSpotDex ETH rates.');
      const t4 = await spotDex.setEthRates(usdcAddr, ethPriceUsd) as ethers.TransactionResponse;
      console.log(`  [ETH 4/4] MockSpotDex  setEthRates tx: ${t4.hash}`);
      await t4.wait(); console.log('             confirmed ✓');
    }

    txCount += spotDex ? 4 : 3;
    console.log('');
  }

  // ── 5. Summary ────────────────────────────────────────────────────────────
  console.log(`Done. ${txCount} transaction(s) confirmed.`);
  if (btcPriceUsd) console.log(`  BTC → $${btcPriceUsd.toLocaleString()} on oracle, Aave, Hyperliquid${spotDex ? ', MockSpotDex' : ''}`);
  if (ethPriceUsd) console.log(`  ETH → $${ethPriceUsd.toLocaleString()} on oracle, Aave, Hyperliquid${spotDex ? ', MockSpotDex' : ''}`);
  console.log('Next: run the bot batch or call processBatchPhase1 — it will use the new oracle prices.');
}

main()
  .then(() => process.exit(0))
  .catch((err: Error) => {
    console.error('\nError:', err.message ?? err);
    process.exit(1);
  });
