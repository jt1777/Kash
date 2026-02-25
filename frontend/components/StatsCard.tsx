'use client';

import { useReadContract, usePublicClient } from 'wagmi';
import { useQuery } from '@tanstack/react-query';
import { CONTRACTS } from '@/lib/contracts/addresses';
import { kashYieldABI } from '@/lib/contracts/kashYieldABI';
import { kashTokenABI } from '@/lib/contracts/kashTokenABI';
import { formatEther } from 'viem';
import { useAccount } from 'wagmi';
import { useMemo } from 'react';

// The current smart contract only takes ETH or wETH, not wBTC. We will create and link
// another smart contract for wBTC to this front end, but at a later date. In the future,
// the front end will need to read from 2 different contracts (1 for ETH and 1 for wBTC).

export function StatsCard() {
  const { address } = useAccount();
  const publicClient = usePublicClient();

  const { data: nav } = useReadContract({
    address: CONTRACTS.kashYieldEth,
    abi: kashYieldABI,
    functionName: 'currentNAV',
  });

  // Deposits: read only from chain (event logs), no contract view calls.
  // MintRequested = user requested a mint (amountIn, batchCycle). BatchProcessed = batch settled.
  // Settled ETH = sum of amountIn from MintRequested where batchCycle appears in BatchProcessed.
  // A future smart contract should expose a view function that returns the total amount of ETH
  // deposited by each wallet (e.g. totalDepositedEth(address user) returns uint256), so the
  // front end can call it once instead of deriving from events.
  const { data: mintEvents } = useQuery({
    queryKey: ['userMintEvents', address, publicClient?.chain?.id],
    queryFn: async () => {
      if (!publicClient || !address) return [];
      const logs = await publicClient.getContractEvents({
        address: CONTRACTS.kashYieldEth,
        abi: kashYieldABI,
        eventName: 'MintRequested',
        args: { user: address as `0x${string}` },
      });
      return logs;
    },
    enabled: !!publicClient && !!address,
  });

  const { data: batchProcessedEvents } = useQuery({
    queryKey: ['batchProcessedEvents', publicClient?.chain?.id],
    queryFn: async () => {
      if (!publicClient) return [];
      const logs = await publicClient.getContractEvents({
        address: CONTRACTS.kashYieldEth,
        abi: kashYieldABI,
        eventName: 'BatchProcessed',
      });
      return logs;
    },
    enabled: !!publicClient,
  });

  const { data: kashBalance } = useReadContract({
    address: CONTRACTS.kashTokenEth,
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
          ${nav ? formatEther(nav) : '1.00'}
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
            ? settledFromChain.settledEth > 0n
              ? `${Number(formatEther(settledFromChain.settledEth)).toLocaleString(undefined, { maximumFractionDigits: 4 })} ETH`
              : '0.00 ETH'
            : '—'}
        </p>
        <p className="text-xs text-gray-500 mt-1">
          {address ? '' : 'Connect wallet'}
        </p>
        {address && (mintEvents?.length ?? 0) > 0 && (
          <p className="text-xs text-gray-500 mt-0.5">
            {mintEvents!.length} request{mintEvents!.length !== 1 ? 's' : ''} · {settledFromChain.settledCount} settled
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
          KASH tokens
        </p>
      </div>
    </>
  );
}
