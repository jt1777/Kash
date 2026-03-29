'use client';

import { useReadContract, useAccount } from 'wagmi';
import { CONTRACTS } from '@/lib/contracts/addresses';
import { kashYieldABI } from '@/lib/contracts/kashYieldABI';
import { kashTokenABI } from '@/lib/contracts/kashTokenABI';
import { formatEther } from 'viem';
import { useMemo } from 'react';

type Product = 'eth' | 'btc';

export function StatsCard({ product = 'eth' }: { product?: Product }) {
  const { address, connector } = useAccount();

  const isBtc = product === 'btc' && CONTRACTS.kashYieldBtc && CONTRACTS.kashTokenBtc;
  const kashYield = isBtc ? CONTRACTS.kashYieldBtc! : CONTRACTS.kashYieldEth;
  const kashToken = isBtc ? CONTRACTS.kashTokenBtc! : CONTRACTS.kashTokenEth;

  const { data: nav } = useReadContract({
    address: kashYield,
    abi: kashYieldABI,
    functionName: 'currentNAV',
  });

  const { data: kashBalance } = useReadContract({
    address: kashToken,
    abi: kashTokenABI,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
  });

  const { data: kashTotalSupply } = useReadContract({
    address: kashToken,
    abi: kashTokenABI,
    functionName: 'totalSupply',
  });

  const navDisplay = useMemo(() => {
    if (nav === undefined) return '1.000000';
    const microUnits = 10n ** 12n; // 10^(18-6): wei per 0.000001 NAV
    const roundedMicro = (nav + microUnits / 2n) / microUnits;
    const whole = roundedMicro / 1_000_000n;
    const frac = roundedMicro % 1_000_000n;
    return `${whole}.${frac.toString().padStart(6, '0')}`;
  }, [nav]);

  const totalNavDisplay = useMemo(() => {
    if (nav === undefined || kashTotalSupply === undefined) return '—';
    // totalNAV (USD, 18 dec) = totalSupply (18 dec) * nav (18 dec) / 1e18
    const totalUsd = (kashTotalSupply * nav) / 10n ** 18n;
    return `$${Number(formatEther(totalUsd)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }, [nav, kashTotalSupply]);

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
          <span className="text-sm text-gray-500 font-medium">Total NAV</span>
          <div className="w-8 h-8 bg-green-100 rounded-lg flex items-center justify-center">
            <svg className="w-4 h-4 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
          </div>
        </div>
        <p className="text-3xl font-bold text-gray-900 leading-tight">
          {totalNavDisplay}
        </p>
        <p className="text-xs text-gray-500 mt-1">
          Total contract value (USD)
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
