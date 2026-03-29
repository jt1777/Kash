'use client';

import { useReadContract, usePublicClient } from 'wagmi';
import { useQuery } from '@tanstack/react-query';
import { CONTRACTS } from '@/lib/contracts/addresses';
import { kashYieldABI } from '@/lib/contracts/kashYieldABI';
import { kashTokenABI } from '@/lib/contracts/kashTokenABI';
import { formatEther, formatUnits } from 'viem';
import { useAccount } from 'wagmi';
import { useMemo } from 'react';

type Product = 'eth' | 'btc';

export function StatsCard({ product = 'eth' }: { product?: Product }) {
  const { address, connector } = useAccount();
  const publicClient = usePublicClient();

  const isBtc = product === 'btc' && CONTRACTS.kashYieldBtc && CONTRACTS.kashTokenBtc;
  const kashYield = isBtc ? CONTRACTS.kashYieldBtc! : CONTRACTS.kashYieldEth;
  const kashToken = isBtc ? CONTRACTS.kashTokenBtc! : CONTRACTS.kashTokenEth;

  const { data: nav } = useReadContract({
    address: kashYield,
    abi: kashYieldABI,
    functionName: 'currentNAV',
  });

  // Deposits: prefer contract view (getTotalDepositedBtc/Eth, getTotalRedeemedBtc/Eth) when available; else derive from events.
  const depositViewName = isBtc ? 'getTotalDepositedBtc' : 'getTotalDepositedEth';
  const redeemViewName = isBtc ? 'getTotalRedeemedBtc' : 'getTotalRedeemedEth';
  const { data: totalDepositedFromView } = useReadContract({
    address: kashYield,
    abi: kashYieldABI,
    functionName: depositViewName,
    args: address ? [address] : undefined,
  });
  const { data: totalRedeemedFromView } = useReadContract({
    address: kashYield,
    abi: kashYieldABI,
    functionName: redeemViewName,
    args: address ? [address] : undefined,
  });

  // Fallback: event-based totals (used when contract has no view or view fails). Block range ~6 days on Arbitrum.
  const EVENT_BLOCK_RANGE = 500_000n;

  const { data: mintEvents } = useQuery({
    queryKey: ['userMintEvents', address, publicClient?.chain?.id, kashYield],
    queryFn: async () => {
      if (!publicClient || !address) return [];
      const blockNumber = await publicClient.getBlockNumber();
      const fromBlock = blockNumber > EVENT_BLOCK_RANGE ? blockNumber - EVENT_BLOCK_RANGE : 0n;
      const logs = await publicClient.getContractEvents({
        address: kashYield,
        abi: kashYieldABI,
        eventName: 'MintRequested',
        args: { user: address as `0x${string}` },
        fromBlock,
      });
      return logs;
    },
    enabled: !!publicClient && !!address,
  });

  const { data: batchProcessedEvents } = useQuery({
    queryKey: ['batchProcessedEvents', publicClient?.chain?.id, kashYield],
    queryFn: async () => {
      if (!publicClient) return [];
      const blockNumber = await publicClient.getBlockNumber();
      const fromBlock = blockNumber > EVENT_BLOCK_RANGE ? blockNumber - EVENT_BLOCK_RANGE : 0n;
      const logs = await publicClient.getContractEvents({
        address: kashYield,
        abi: kashYieldABI,
        eventName: 'BatchProcessed',
        fromBlock,
      });
      return logs;
    },
    enabled: !!publicClient,
  });

  // Redeemed amount (asset returned to user from Phase 2). TokensClaimed(..., isMint: false) = redeem payout.
  const assetAddress = isBtc ? CONTRACTS.mockWbtc : ('0x0000000000000000000000000000000000000000' as `0x${string}`);
  const { data: tokensClaimedEvents } = useQuery({
    queryKey: ['tokensClaimedRedeem', address, publicClient?.chain?.id, kashYield],
    queryFn: async () => {
      if (!publicClient || !address) return [];
      const blockNumber = await publicClient.getBlockNumber();
      const fromBlock = blockNumber > EVENT_BLOCK_RANGE ? blockNumber - EVENT_BLOCK_RANGE : 0n;
      const logs = await publicClient.getContractEvents({
        address: kashYield,
        abi: kashYieldABI,
        eventName: 'TokensClaimed',
        args: { user: address as `0x${string}` },
        fromBlock,
      });
      return logs;
    },
    enabled: !!publicClient && !!address,
  });

  const { data: kashBalance } = useReadContract({
    address: kashToken,
    abi: kashTokenABI,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
  });

  const processedBatchCycles = useMemo(() => {
    if (!batchProcessedEvents?.length) return new Set<bigint>();
    return new Set(batchProcessedEvents.map((e) => e.args.batchCycle).filter((c): c is bigint => c !== undefined));
  }, [batchProcessedEvents]);

  const settledFromChain = useMemo(() => {
    if (!mintEvents?.length || processedBatchCycles.size === 0) return { settledEth: 0n, settledCount: 0 };
    let settledEth = 0n;
    let settledCount = 0;
    for (const log of mintEvents) {
      const batchCycle = log.args.batchCycle;
      const amountIn = log.args.amountIn;
      if (batchCycle !== undefined && processedBatchCycles.has(batchCycle) && amountIn !== undefined) {
        settledEth += amountIn;
        settledCount += 1;
      }
    }
    return { settledEth, settledCount };
  }, [mintEvents, processedBatchCycles]);

  const totalRedeemed = useMemo(() => {
    if (!tokensClaimedEvents?.length) return 0n;
    const assetLower = assetAddress.toLowerCase();
    let sum = 0n;
    for (const log of tokensClaimedEvents) {
      const token = log.args.token;
      const isMint = log.args.isMint;
      const amount = log.args.amount;
      if (token && typeof isMint === 'boolean' && !isMint && token.toLowerCase() === assetLower && amount !== undefined) {
        sum += amount;
      }
    }
    return sum;
  }, [tokensClaimedEvents, assetAddress]);

  // Use view when available (new contracts), else event-derived totals
  const depositedTotal = totalDepositedFromView ?? settledFromChain.settledEth;
  const redeemedTotal = totalRedeemedFromView ?? totalRedeemed;
  const netDeposits = useMemo(() => {
    if (redeemedTotal >= depositedTotal) return 0n;
    return depositedTotal - redeemedTotal;
  }, [depositedTotal, redeemedTotal]);

  const navDisplay = useMemo(() => {
    if (nav === undefined) return '1.000000';
    const microUnits = 10n ** 12n; // 10^(18-6): wei per 0.000001 NAV
    const roundedMicro = (nav + microUnits / 2n) / microUnits;
    const whole = roundedMicro / 1_000_000n;
    const frac = roundedMicro % 1_000_000n;
    return `${whole}.${frac.toString().padStart(6, '0')}`;
  }, [nav]);

  return (
    <>
      <div className="bg-white rounded-xl shadow-md p-6 border border-gray-100">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm text-gray-500 font-medium">Current NAV</span>
          <div className="w-8 h-8 bg-indigo-100 rounded-lg flex items-center justify-center">
            <svg className="w-4 h-4 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
        </div>
        <p className="text-3xl font-bold text-gray-900">
          ${navDisplay}
        </p>
        <p className="text-xs text-gray-500 mt-1">
          Per KASH token
        </p>
      </div>

      <div className="bg-white rounded-xl shadow-md p-6 border border-gray-100">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm text-gray-500 font-medium">Deposits</span>
          <div className="w-8 h-8 bg-green-100 rounded-lg flex items-center justify-center">
            <svg className="w-4 h-4 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
          </div>
        </div>
        <p className="text-3xl font-bold text-gray-900 leading-tight">
          {address
            ? netDeposits > 0n
              ? isBtc
                ? `${Number(formatUnits(netDeposits, 8)).toLocaleString(undefined, { maximumFractionDigits: 6 })} wBTC`
                : `${Number(formatEther(netDeposits)).toLocaleString(undefined, { maximumFractionDigits: 4 })} ETH`
              : isBtc
                ? '0.00 wBTC'
                : '0.00 ETH'
            : '—'}
        </p>
        <p className="text-xs text-gray-500 mt-1">
          {address ? (redeemedTotal > 0n ? 'Net (deposits − redeemed)' : '') : 'Connect wallet'}
        </p>
        {address && (mintEvents?.length ?? 0) > 0 && (
          <p className="text-xs text-gray-500 mt-0.5">
            {mintEvents!.length} request{mintEvents!.length !== 1 ? 's' : ''} · {settledFromChain.settledCount} settled
            {redeemedTotal > 0n && ` · ${isBtc ? Number(formatUnits(redeemedTotal, 8)).toFixed(4) : Number(formatEther(redeemedTotal)).toFixed(4)} redeemed`}
          </p>
        )}
      </div>

      <div className="bg-white rounded-xl shadow-md p-6 border border-gray-100">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm text-gray-500 font-medium">Your KASH Balance</span>
          <div className="w-8 h-8 bg-purple-100 rounded-lg flex items-center justify-center">
            <svg className="w-4 h-4 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
            </svg>
          </div>
        </div>
        <p className="text-3xl font-bold text-gray-900">
          {address && kashBalance ? Number(formatEther(kashBalance)).toFixed(2) : '0.00'}
        </p>
        <p className="text-xs text-gray-500 mt-1">
          {isBtc ? 'KASH-BTC' : 'KASH-ETH'} tokens
        </p>
        <div className="mt-3 pt-3 border-t border-gray-100">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500 font-mono truncate" title={kashToken}>
              {kashToken.slice(0, 6)}…{kashToken.slice(-4)}
            </span>
            <button
              type="button"
              onClick={() => navigator.clipboard.writeText(kashToken)}
              className="text-xs text-gray-400 hover:text-gray-600 transition cursor-pointer"
              title="Copy token address"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </button>
            <button
              type="button"
              onClick={async () => {
                const params = {
                  type: 'ERC20' as const,
                  options: {
                    address: kashToken,
                    symbol: isBtc ? 'KASH_BTC' : 'KASH_ETH',
                    decimals: 18,
                  },
                };
                try {
                  const provider = await connector?.getProvider();
                  if (provider && typeof (provider as any).request === 'function') {
                    await (provider as any).request({
                      method: 'wallet_watchAsset',
                      params,
                    });
                  }
                } catch (e) {
                  console.warn('wallet_watchAsset failed:', e);
                }
              }}
              disabled={!address}
              className="text-xs text-indigo-600 hover:text-indigo-700 font-medium transition cursor-pointer whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
              title="Add token to wallet"
            >
              + Add to wallet
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
