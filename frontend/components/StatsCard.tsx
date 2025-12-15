'use client';

import { useReadContract } from 'wagmi';
import { CONTRACTS } from '@/lib/contracts/addresses';
import { kashYieldABI } from '@/lib/contracts/kashYieldABI';
import { kashTokenABI } from '@/lib/contracts/kashTokenABI';
import { formatEther } from 'viem';
import { useAccount } from 'wagmi';

export function StatsCard() {
  const { address } = useAccount();

  const { data: nav } = useReadContract({
    address: CONTRACTS.kashYield,
    abi: kashYieldABI,
    functionName: 'currentNAV',
  });

  const { data: feeBps } = useReadContract({
    address: CONTRACTS.kashYield,
    abi: kashYieldABI,
    functionName: 'feeBps',
  });

  const { data: kashBalance } = useReadContract({
    address: CONTRACTS.kashToken,
    abi: kashTokenABI,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
  });

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
          <span className="text-sm text-gray-500 font-medium">Protocol Fee</span>
          <div className="w-8 h-8 bg-green-100 rounded-lg flex items-center justify-center">
            <svg className="w-4 h-4 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
            </svg>
          </div>
        </div>
        <p className="text-3xl font-bold text-gray-900">
          {feeBps ? `${Number(feeBps) / 100}%` : '0.03%'}
        </p>
        <p className="text-xs text-gray-500 mt-1">
          On all transactions
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
