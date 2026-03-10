/**
 * Owner Status Script
 *
 * Shows protocol state for KashYieldETH or KashYieldBtc:
 * - Asset balance in contract (user deposits vs excess/withdrawable)
 * - Aave: supplied ETH/wBTC, borrowed USDC
 * - Hyperliquid: USDC in spot, wBTC/ETH in spot, perp positions (ETH/BTC: size, collateral, active)
 *
 * Usage:
 *   PRODUCT=eth KASH_YIELD_ETH_ADDRESS=0x... npm run owner:status
 *   PRODUCT=btc KASH_YIELD_BTC_ADDRESS=0x... AAVE_POOL_ADDRESS=0x... npm run owner:status
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
  { inputs: [], name: 'decimals', outputs: [{ name: '', type: 'uint8' }], stateMutability: 'view', type: 'function' },
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
  let usdcBorrowed = 0n;
  let hlSpotBalance = 0n;

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
    console.log('  Note: Excess may be (1) wBTC for redeemers whose Phase 2 did not run or failed, (2) from mints not yet deployed, or (3) owner top-ups. See recent batches and RedeemRequested/TokensClaimed events to correlate.');
  } else {
    totalInContract = await provider.getBalance(config.kashYieldAddress);
    reserved = await kashYield.getReservedEth();
    const excess = totalInContract > reserved ? totalInContract - reserved : 0n;
    console.log('📦 Asset in Contract (ETH)');
    console.log('  Total:           ', ethers.formatEther(totalInContract), 'ETH');
    console.log('  User deposits:   ', ethers.formatEther(reserved), 'ETH (reserved)');
    console.log('  Excess (owner):  ', ethers.formatEther(excess), 'ETH (withdrawable via ownerWithdrawEth)');
    console.log('  Note: Excess may be (1) ETH for redeemers whose Phase 2 did not run or failed, (2) from mints not yet deployed, or (3) owner top-ups. See recent batches and events to correlate.');
  }
  console.log('');

  // ─── KASH in Contract ────────────────────────────────────────────────────
  try {
    const kashTokenAddr = isBtc
      ? await kashYield.kashTokenBtc()
      : await kashYield.kashTokenEth();
    const kashToken = new ethers.Contract(kashTokenAddr, ERC20_ABI, provider);
    const kashInContract = await kashToken.balanceOf(config.kashYieldAddress);
    const kashDecimals = await kashToken.decimals();
    const kashLabel = isBtc ? 'KASH-BTC' : 'KASH-ETH';
    console.log(`📌 KASH in Contract (${kashLabel})`);
    console.log('  Total:           ', ethers.formatUnits(kashInContract, kashDecimals), kashLabel, `(${kashDecimals} decimals)`);
    console.log('  Note: Includes KASH transferred in by redeem requests not yet processed in Phase 2.');
  } catch (e: any) {
    console.log('📌 KASH in Contract: failed to fetch –', e?.message ?? e);
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
    try {
      hlSpotBalance = await kashYield.getHyperliquidSpotBalance();
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
      hlSpotBalance = await hl.getSpotBalance(config.kashYieldAddress);
    }
    // HL spot wBTC (and ETH): MockHyperliquid has btcBalance(address), ethBalance(address) in 18 decimals
    let hlSpotWbtc = 0n;
    let hlSpotEth = 0n;
    try {
      const hlSpotAbi = [
        { inputs: [{ name: '', type: 'address' }], name: 'btcBalance', outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' },
        { inputs: [{ name: '', type: 'address' }], name: 'ethBalance', outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' },
      ];
      const hlContract = new ethers.Contract(hlAddr, hlSpotAbi, provider);
      hlSpotWbtc = await hlContract.btcBalance(config.kashYieldAddress);
      hlSpotEth = await hlContract.ethBalance(config.kashYieldAddress);
    } catch {
      // Mock may not expose these
    }
    console.log('🔄 Hyperliquid');
    console.log('  USDC in spot:    ', ethers.formatUnits(hlSpotBalance, 6), 'USDC');
    if (isBtc) {
      console.log('  wBTC in spot:    ', ethers.formatEther(hlSpotWbtc), 'wBTC');
    } else {
      console.log('  ETH in spot:     ', ethers.formatEther(hlSpotEth), 'ETH');
    }
    if (hlSpotBalance > 0n && usdcBorrowed > 0n) {
      console.log('  Run \'npm run owner:recover-hl-usdc\' to withdraw HL USDC and repay Aave.');
    }

    // Perp positions: show short size in asset (BTC/ETH), collateral, and open vs closed. Mock does not zero size/collateral when closed, so closed positions still show prior values.
    try {
      const [ethSize, ethCollateral, , ethLong, ethActive] = await kashYield.getHyperliquidPosition('ETH');
      const [btcSize, btcCollateral, , btcLong, btcActive] = await kashYield.getHyperliquidPosition('BTC');
      console.log('  Perp positions:');
      const ethLabel = ethLong ? 'ETH long' : 'ETH short';
      const btcLabel = btcLong ? 'BTC long' : 'BTC short';
      console.log(`    ${ethLabel}: ${ethers.formatEther(ethSize)} ETH, collateral ${ethers.formatUnits(ethCollateral, 6)} USDC — ${ethActive ? 'open' : 'closed'}`);
      console.log(`    ${btcLabel}: ${ethers.formatEther(btcSize)} BTC, collateral ${ethers.formatUnits(btcCollateral, 6)} USDC — ${btcActive ? 'open' : 'closed'}`);
      if (!ethActive && !btcActive && (ethSize > 0n || btcSize > 0n || ethCollateral > 0n || btcCollateral > 0n)) {
        console.log('  (Closed positions still show last size/collateral; mock does not clear them.)');
      }
      if (usdcBorrowed > 0n && hlSpotBalance === 0n && !ethActive && !btcActive) {
        console.log('  Note: Borrowed USDC from Aave is expected in HL (spot or perp collateral). Spot=0 and no active perp may mean the deploy flow did not complete.');
      }
    } catch (e: any) {
      console.log('  Perp positions: failed to fetch –', e?.message ?? e);
    }
  }
  console.log('');

  // ─── 4. Recent batches (for correlating excess asset / pending redeems) ─────
  try {
    const currentCycle = await kashYield.getCurrentBatchCycle();
    const currentBn = typeof currentCycle === 'bigint' ? currentCycle : BigInt(currentCycle.toString());
    const lookback = 5;
    // Contract stores USD in 18 decimals (NAV * amount / 1e18)
    const USD_DECIMALS = 18;
    console.log('📅 Recent batches (cycle, phase, processed, totalMintUSD, totalRedeemUSD)');
    for (let i = 0; i <= lookback; i++) {
      const cycle = currentBn - BigInt(i);
      if (cycle < 0n) break;
      const phase = await kashYield.batchPhase(cycle);
      const info = await kashYield.getBatchInfo(cycle);
      const totalMint = BigInt(info.totalMintUSD?.toString() ?? '0');
      const totalRedeem = BigInt(info.totalRedeemUSD?.toString() ?? '0');
      const processed = info.processed === true;
      const phaseNum = Number(phase);
      const mintStr = ethers.formatUnits(totalMint, USD_DECIMALS);
      const redeemStr = ethers.formatUnits(totalRedeem, USD_DECIMALS);
      console.log(`  ${cycle}: phase=${phaseNum} processed=${processed} mint=${mintStr} redeem=${redeemStr}`);
    }
    console.log('  Use these cycles with RedeemRequested/TokensClaimed events to see if excess wBTC matches pending or failed redemptions.');
  } catch (e: any) {
    console.log('📅 Recent batches: failed to fetch –', e?.message ?? e);
  }
  console.log('');

  console.log('═'.repeat(55));
  console.log('Done.\n');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Error:', err.message);
    process.exit(1);
  });
