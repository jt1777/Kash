/**
 * Owner Status Script
 *
 * Shows protocol state for KashYieldETH or KashYieldBtc:
 * - Asset balance in contract (user deposits vs excess/withdrawable)
 * - Aave: supplied ETH/wBTC, borrowed USDC
 * - Hyperliquid: USDC in spot wallet
 *
 * Usage:
 *   PRODUCT=eth KASH_YIELD_ADDRESS=0x... npm run owner:status
 *   PRODUCT=btc KASH_YIELD_ADDRESS=0x... AAVE_POOL_ADDRESS=0x... npm run owner:status
 */

import { ethers } from 'ethers';
import { config } from '../config';
import { kashYieldABI } from '../contracts/kashYieldABI';

const AAVE_POOL_ABI = [
  {
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'user', type: 'address' },
    ],
    name: 'getATokenBalance',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'user', type: 'address' }],
    name: 'getBorrowedAmount',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'usdcAddress',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'wbtcAddress',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

const ERC20_ABI = [
  {
    inputs: [{ name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

async function main() {
  if (!config.kashYieldAddress) {
    throw new Error('KASH_YIELD_ADDRESS is required');
  }

  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const kashYield = new ethers.Contract(
    config.kashYieldAddress,
    kashYieldABI,
    provider
  );

  const isBtc = config.product === 'btc';
  const productName = isBtc ? 'KashYieldBtc (wBTC)' : 'KashYieldETH';

  console.log('\n📊 Owner Status –', productName);
  console.log('═'.repeat(55));
  console.log(`Contract: ${config.kashYieldAddress}`);
  console.log(`Product: ${config.product.toUpperCase()}`);
  console.log('');

  // ─── 1. Asset in Contract ───────────────────────────────────────────────
  let totalInContract: bigint;
  let reserved: bigint;

  if (isBtc) {
    const wbtcAddress = await kashYield.wbtcAddress();
    const wbtc = new ethers.Contract(wbtcAddress, ERC20_ABI, provider);
    totalInContract = await wbtc.balanceOf(config.kashYieldAddress);
    reserved = await kashYield.getReservedBtc();
    const excess = totalInContract > reserved ? totalInContract - reserved : 0n;
    console.log('📦 Asset in Contract (wBTC)');
    console.log('  Total:           ', ethers.formatUnits(totalInContract, 8), 'wBTC');
    console.log('  User deposits:   ', ethers.formatUnits(reserved, 8), 'wBTC (reserved)');
    console.log('  Excess (owner):  ', ethers.formatUnits(excess, 8), 'wBTC (withdrawable via ownerWithdrawWbtc)');
    console.log('  Note: Excess may include owner top-ups or protocol yield.');
  } else {
    totalInContract = await provider.getBalance(config.kashYieldAddress);
    reserved = await kashYield.getReservedEth();
    const excess = totalInContract > reserved ? totalInContract - reserved : 0n;
    console.log('📦 Asset in Contract (ETH)');
    console.log('  Total:           ', ethers.formatEther(totalInContract), 'ETH');
    console.log('  User deposits:   ', ethers.formatEther(reserved), 'ETH (reserved)');
    console.log('  Excess (owner):  ', ethers.formatEther(excess), 'ETH (withdrawable via ownerWithdrawEth)');
    console.log('  Note: Excess may include owner top-ups or protocol yield.');
  }
  console.log('');

  // ─── 2. Aave ────────────────────────────────────────────────────────────
  const aavePoolAddr = await kashYield.aavePoolAddress();
  if (!aavePoolAddr || aavePoolAddr === ethers.ZeroAddress) {
    console.log('🏦 Aave: Not configured');
  } else {
    const aavePool = new ethers.Contract(aavePoolAddr, AAVE_POOL_ABI, provider);
    let wethAddr: string | null = null;
    if (!isBtc) {
      try {
        wethAddr = await kashYield.wethAddress();
      } catch {
        wethAddr = null;
      }
    }
    const wbtcAddr = isBtc ? await kashYield.wbtcAddress() : null;

    let aaveSupplied = 0n;

    if (isBtc && wbtcAddr) {
      try {
        aaveSupplied = await aavePool.getATokenBalance(wbtcAddr, config.kashYieldAddress);
      } catch {
        // Mock may use different asset ids
      }
      console.log('🏦 Aave');
      console.log('  Supplied wBTC:   ', ethers.formatUnits(aaveSupplied, 8), 'wBTC');
    } else {
      try {
        aaveSupplied = await aavePool.getATokenBalance(wethAddr ?? ethers.ZeroAddress, config.kashYieldAddress);
      } catch {
        try {
          aaveSupplied = await aavePool.getATokenBalance(ethers.ZeroAddress, config.kashYieldAddress);
        } catch {
          aaveSupplied = 0n;
        }
      }
      console.log('🏦 Aave');
      console.log('  Supplied ETH:    ', ethers.formatEther(aaveSupplied), 'ETH');
    }

    let usdcBorrowed = 0n;
    try {
      usdcBorrowed = await aavePool.getBorrowedAmount(config.kashYieldAddress);
    } catch {
      // Real Aave doesn't have getBorrowedAmount
    }
    console.log('  Borrowed USDC:   ', ethers.formatUnits(usdcBorrowed, 6), 'USDC');
  }
  console.log('');

  // ─── 3. Hyperliquid ──────────────────────────────────────────────────────
  let hlAddr: string | null = null;
  try {
    hlAddr = await kashYield.hyperliquidAddress();
  } catch {
    hlAddr = null;
  }
  if (!hlAddr || hlAddr === ethers.ZeroAddress) {
    console.log('🔄 Hyperliquid: Not configured');
  } else {
    let spotBalance = 0n;
    try {
      spotBalance = await kashYield.getHyperliquidSpotBalance();
    } catch {
      // Fallback: call HL directly
      const hlAbi = [
        {
          inputs: [{ name: 'user', type: 'address' }],
          name: 'getSpotBalance',
          outputs: [{ name: '', type: 'uint256' }],
          stateMutability: 'view',
          type: 'function',
        },
      ];
      const hl = new ethers.Contract(hlAddr, hlAbi, provider);
      spotBalance = await hl.getSpotBalance(config.kashYieldAddress);
    }
    console.log('🔄 Hyperliquid');
    console.log('  USDC in spot:    ', ethers.formatUnits(spotBalance, 6), 'USDC');
  }
  console.log('');

  // Optional: HL perp position
  if (hlAddr && hlAddr !== ethers.ZeroAddress) {
    try {
      const [ethSize, , , , ethActive] = await kashYield.getHyperliquidPosition('ETH').catch(() => [0n, 0n, 0n, false, false]);
      const [btcSize, , , , btcActive] = await kashYield.getHyperliquidPosition('BTC').catch(() => [0n, 0n, 0n, false, false]);
      if (ethActive || btcActive) {
        console.log('  Perp positions:');
        if (ethActive) console.log('    ETH short size:', ethers.formatEther(ethSize), 'ETH');
        if (btcActive) console.log('    BTC short size:', ethers.formatEther(btcSize), 'BTC');
        console.log('');
      }
    } catch {
      // Ignore
    }
  }

  console.log('═'.repeat(55));
  console.log('Done.\n');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Error:', err.message);
    process.exit(1);
  });
