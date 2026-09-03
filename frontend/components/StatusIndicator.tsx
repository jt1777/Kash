'use client';

import { useState, useEffect } from 'react';
import { useReadContract } from 'wagmi';
import { CONTRACTS } from '@/lib/contracts/addresses';
import { vaultAbi } from '@/lib/contracts/vaultAbi';

function getUtcTimeString(): string {
  const now = new Date();
  const h = now.getUTCHours();
  const m = now.getUTCMinutes();
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

type Product = 'eth' | 'btc';

export function StatusIndicator({ product = 'eth' }: { product?: Product }) {
  const [utcTime, setUtcTime] = useState(() => getUtcTimeString());
  const isBtc = product === 'btc' && CONTRACTS.kashYieldBtc;
  const kashYield = isBtc ? CONTRACTS.kashYieldBtc! : CONTRACTS.kashYieldEth;

  useEffect(() => {
    const t = setInterval(() => setUtcTime(getUtcTimeString()), 60_000);
    return () => clearInterval(t);
  }, []);
  const { data: isUserWindow } = useReadContract({
    address: kashYield,
    abi: vaultAbi(product),
    functionName: 'isUserWindow',
  });

  const { data: isProcessingWindow } = useReadContract({
    address: kashYield,
    abi: vaultAbi(product),
    functionName: 'isProcessingWindow',
  });

  // When user window is open, deposits are allowed – show that first (even if processing window overlaps, e.g. KashYieldBtc testing)
  if (isUserWindow) {
    return (
      <div className="mb-6 bg-green-50 border border-green-200 rounded-lg p-4">
        <div className="flex items-center">
          <div className="shrink-0">
            <div className="h-2 w-2 rounded-full bg-green-500 animate-pulse"></div>
          </div>
          <div className="ml-3">
            <h3 className="text-sm font-medium text-green-800">
              The current time is {utcTime} UTC. Window open time for Users 00:00-23:40 UTC.
            </h3>
            <p className="text-sm text-green-700 mt-1">
              All mint and redemption requests each day will be processed at the batch processing time (23:40 UTC).
            </p>
          </div>
        </div>
      </div>
    );
  }

  // User window closed; show processing status when applicable
  if (isProcessingWindow) {
    return (
      <div className="mb-6 bg-amber-50 border border-amber-200 rounded-lg p-4">
        <div className="flex items-center">
          <div className="shrink-0">
            <div className="animate-spin rounded-full h-5 w-5 border-2 border-amber-600 border-t-transparent"></div>
          </div>
          <div className="ml-3">
            <h3 className="text-sm font-medium text-amber-800">
              Processing Window Active (23:40-23:59 UTC)
            </h3>
            <p className="text-sm text-amber-700 mt-1">
              Batch processing in progress. User transactions temporarily disabled. Check back after 00:00 UTC.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return null;
}
