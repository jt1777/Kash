'use client';

import { useReadContract, usePublicClient } from 'wagmi';
import { useQuery } from '@tanstack/react-query';
import { CONTRACTS } from '@/lib/contracts/addresses';
import { kashYieldABI } from '@/lib/contracts/kashYieldABI';
import { kashTokenABI } from '@/lib/contracts/kashTokenABI';
import { formatEther, formatUnits, zeroAddress } from 'viem';
import { useAccount } from 'wagmi';
import { useMemo } from 'react';

const TOKEN_INFO: Record<string, { symbol: string; decimals: number }> = {
  [zeroAddress.toLowerCase()]: { symbol: 'ETH', decimals: 18 },
  [(CONTRACTS.tokens.weth as string).toLowerCase()]: { symbol: 'wETH', decimals: 18 },
  [(CONTRACTS.tokens.wbtc as string).toLowerCase()]: { symbol: 'wBTC', decimals: 8 },
};

export function StatsCard() {
  const { address } = useAccount();
  const publicClient = usePublicClient();

  const { data: nav } = useReadContract({
    address: CONTRACTS.kashYield,
    abi: kashYieldABI,
    functionName: 'currentNAV',
  });

  const { data: mintEvents } = useQuery({
    queryKey: ['userMintEvents', address, publicClient?.chain?.id],
    queryFn: async () => {
      if (!publicClient || !address) return [];
      const logs = await publicClient.getContractEvents({
        address: CONTRACTS.kashYield,
        abi: kashYieldABI,
        eventName: 'MintRequested',
        args: { user: address as `0x${string}` },
      });
      return logs;
    },
    enabled: !!publicClient && !!address,
  });

  const { data: kashBalance } = useReadContract({
    address: CONTRACTS.kashToken,
    abi: kashTokenABI,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
  });

  const userTotalDeposits = useMemo(() => {
    if (!mintEvents?.length) return null;
    const totals: Record<string, bigint> = {};
    for (const log of mintEvents) {
      const tokenIn = log.args.tokenIn;
      const amountIn = log.args.amountIn;
      if (tokenIn !== undefined && amountIn !== undefined) {
        const key = (tokenIn as string).toLowerCase();
        totals[key] = (totals[key] ?? 0n) + amountIn;
      }
    }
    const parts: string[] = [];
    for (const [tokenKey, amount] of Object.entries(totals)) {
      if (amount === 0n) continue;
      const info = TOKEN_INFO[tokenKey];
      const symbol = info?.symbol ?? 'Asset';
      const decimals = info?.decimals ?? 18;
      const formatted = Number(formatUnits(amount, decimals)).toLocaleString(undefined, { maximumFractionDigits: 6 });
      parts.push(`${formatted} ${symbol}`);
    }
    return parts.length > 0 ? parts.join(' · ') : null;
  }, [mintEvents]);

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
          {userTotalDeposits ?? (address ? '—' : '0')}
        </p>
        <p className="text-xs text-gray-500 mt-1">
          {userTotalDeposits ? 'Your total deposits' : (address ? 'No deposits yet' : 'Connect wallet')}
        </p>
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
