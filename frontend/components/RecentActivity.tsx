'use client';

import { useAccount } from 'wagmi';
import { useState, useEffect, useCallback } from 'react';
import { ARBITRUM_SEPOLIA_CHAIN_ID, ARBITRUM_SEPOLIA_BLOCK_EXPLORER } from '@/lib/contracts/addresses';

const ACTIVITY_LIMIT = 10;

type ActivityItem = {
  type: 'mint' | 'redeem';
  hash: string;
  timestamp: number;
  blockNumber: string;
};

async function fetchActivity(address: string): Promise<{ list: ActivityItem[]; error?: string }> {
  const res = await fetch(`/api/activity?address=${encodeURIComponent(address)}&limit=${ACTIVITY_LIMIT}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { list: [], error: data.error || 'Failed to load activity' };
  }
  return { list: data.activities ?? [] };
}

function formatTimeAgo(ts: number): string {
  const sec = Math.floor(Date.now() / 1000 - ts);
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  if (sec < 604800) return `${Math.floor(sec / 86400)}d ago`;
  return new Date(ts * 1000).toLocaleDateString();
}

export function RecentActivity() {
  const { address, chain } = useAccount();
  const chainId = chain?.id ?? 0;
  const isArbitrumSepolia = chainId === ARBITRUM_SEPOLIA_CHAIN_ID;

  const [activities, setActivities] = useState<ActivityItem[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const load = useCallback(async () => {
    if (!address) return;
    setIsLoading(true);
    setLoadError(null);
    try {
      const { list, error } = await fetchActivity(address);
      setActivities(list);
      setLoadError(error ?? null);
    } finally {
      setIsLoading(false);
    }
  }, [address]);

  useEffect(() => {
    if (address && isArbitrumSepolia) load();
    else {
      setActivities([]);
      setLoadError(null);
    }
  }, [address, isArbitrumSepolia, load]);

  if (!address || !isArbitrumSepolia) return null;

  return (
    <div className="rounded-2xl border bg-white shadow-xl p-6 mt-8" style={{ borderColor: 'rgba(0, 255, 255, 0.2)' }}>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold text-gray-900">Recent Activity</h2>
        <button
          type="button"
          onClick={load}
          disabled={isLoading}
          className="text-sm text-gray-500 hover:text-gray-700 transition disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
        >
          Refresh
        </button>
      </div>

      {isLoading ? (
        <div className="py-8 text-center text-gray-500 text-sm">Loading…</div>
      ) : loadError ? (
        <p className="text-sm text-amber-700 py-6 text-center bg-amber-50 border border-amber-200 rounded-lg px-3">
          {loadError === 'Activity API not configured' ? (
            <>Add <code className="text-xs bg-amber-100 px-1 rounded">ETHERSCAN_API_KEY</code> to your .env to see recent activity.</>
          ) : (
            loadError
          )}
        </p>
      ) : activities.length === 0 ? (
        <p className="text-sm text-gray-500 py-6 text-center">
          No KASH mint or redeem transactions yet. Submit a request above.
        </p>
      ) : (
        <ul className="space-y-2">
          {activities.map((item) => (
            <li
              key={item.hash}
              className="flex items-center justify-between gap-4 py-2 px-3 rounded-lg border border-gray-100 hover:bg-gray-50/50 transition"
            >
              <span
                className={`text-sm font-medium shrink-0 w-16 ${
                  item.type === 'mint' ? 'text-indigo-600' : 'text-purple-600'
                }`}
              >
                {item.type === 'mint' ? 'Mint' : 'Redeem'}
              </span>
              <a
                href={`${ARBITRUM_SEPOLIA_BLOCK_EXPLORER}/tx/${item.hash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-xs text-gray-600 hover:text-indigo-600 truncate flex-1 min-w-0"
                title={item.hash}
              >
                {item.hash.slice(0, 10)}…{item.hash.slice(-8)}
              </a>
              <span className="text-xs text-gray-500 shrink-0">{formatTimeAgo(item.timestamp)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
