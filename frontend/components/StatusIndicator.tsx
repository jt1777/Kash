'use client';

import { useState, useEffect } from 'react';
import { useReadContract } from 'wagmi';
import { CONTRACTS } from '@/lib/contracts/addresses';
import { kashYieldABI } from '@/lib/contracts/kashYieldABI';

function getUtcTimeString(): string {
  const now = new Date();
  const h = now.getUTCHours();
  const m = now.getUTCMinutes();
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function StatusIndicator() {
  const [utcTime, setUtcTime] = useState(() => getUtcTimeString());

  useEffect(() => {
    const t = setInterval(() => setUtcTime(getUtcTimeString()), 60_000);
    return () => clearInterval(t);
  }, []);
  const { data: isUserWindow } = useReadContract({
    address: CONTRACTS.kashYieldEth,
    abi: kashYieldABI,
    functionName: 'isUserWindow',
  });

  const { data: isProcessingWindow } = useReadContract({
    address: CONTRACTS.kashYieldEth,
    abi: kashYieldABI,
    functionName: 'isProcessingWindow',
  });

  const { data: isPaused } = useReadContract({
    address: CONTRACTS.kashYieldEth,
    abi: kashYieldABI,
    functionName: 'paused',
  });

  if (isPaused) {
    return (
      <div className="mb-6 bg-red-50 border border-red-200 rounded-lg p-4">
        <div className="flex items-center">
          <div className="shrink-0">
            <svg className="h-5 w-5 text-red-600" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
            </svg>
          </div>
          <div className="ml-3">
            <h3 className="text-sm font-medium text-red-800">
              Protocol Paused
            </h3>
            <p className="text-sm text-red-700 mt-1">
              The protocol is currently paused. Transactions are temporarily disabled.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (isProcessingWindow) {
    return (
      <div className="mb-6 bg-amber-50 border border-amber-200 rounded-lg p-4">
        <div className="flex items-center">
          <div className="shrink-0">
            <div className="animate-spin rounded-full h-5 w-5 border-2 border-amber-600 border-t-transparent"></div>
          </div>
          <div className="ml-3">
            <h3 className="text-sm font-medium text-amber-800">
              Processing Window Active (23:50-23:59 UTC)
            </h3>
            <p className="text-sm text-amber-700 mt-1">
              Batch processing in progress. User transactions are temporarily disabled. Check back soon!
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (isUserWindow) {
    return (
      <div className="mb-6 bg-green-50 border border-green-200 rounded-lg p-4">
        <div className="flex items-center">
          <div className="shrink-0">
            <div className="h-2 w-2 rounded-full bg-green-500 animate-pulse"></div>
          </div>
          <div className="ml-3">
            <h3 className="text-sm font-medium text-green-800">
              Current time is {utcTime} UTC. Window open time for Users 00:00-23:50 UTC.
            </h3>
            <p className="text-sm text-green-700 mt-1">
              All mint and redemption requests each day will be processed at the batch time (23:50 UTC).
            </p>
          </div>
        </div>
      </div>
    );
  }

  return null;
}
