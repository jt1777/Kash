'use client';

import { useAccount, useReadContracts, useWriteContract, useWaitForTransactionReceipt, useEstimateFeesPerGas } from 'wagmi';
import { useState, useEffect, useCallback, useMemo } from 'react';
import { ARBITRUM_SEPOLIA_CHAIN_ID, ARBITRUM_SEPOLIA_BLOCK_EXPLORER, CONTRACTS } from '@/lib/contracts/addresses';
import { kashYieldABI } from '@/lib/contracts/kashYieldABI';

// Fallback max fee when estimate is missing (e.g. 25 gwei for Arbitrum Sepolia)
const FALLBACK_MAX_FEE_WEI = 25n * (10n ** 9n);

const ACTIVITY_LIMIT = 10;

type ActivityItem = {
  type: 'mint' | 'redeem';
  hash: string;
  timestamp: number;
  blockNumber: string;
  batchCycle?: number;
  contractAddress?: string;
};

async function fetchActivity(address: string): Promise<{ list: ActivityItem[]; error?: string }> {
  const res = await fetch(
    `/api/activity?address=${encodeURIComponent(address)}&limit=${ACTIVITY_LIMIT}&_=${Date.now()}`,
    { cache: 'no-store' }
  );
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
  const [cancelTarget, setCancelTarget] = useState<{ contractAddress: string; batchCycle: number; type: 'mint' | 'redeem' } | null>(null);

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

  // For each activity: getBatchInfo (processed?) and getPendingMintRequest/getPendingRedeemRequest (still has request?)
  const readConfigs: { address: `0x${string}`; abi: typeof kashYieldABI; functionName: 'getBatchInfo' | 'getPendingMintRequest' | 'getPendingRedeemRequest'; args: [bigint] | [string, bigint] }[] = [];
  const activityToConfigIndex: number[] = [];
  activities.forEach((a, i) => {
    const contractAddress = a.contractAddress?.trim();
    if (!contractAddress || a.batchCycle == null || !address) return;
    const contract = contractAddress as `0x${string}`;
    const cycle = BigInt(a.batchCycle);
    const batchIdx = readConfigs.length;
    readConfigs.push({ address: contract, abi: kashYieldABI, functionName: 'getBatchInfo', args: [cycle] });
    if (a.type === 'mint') {
      readConfigs.push({ address: contract, abi: kashYieldABI, functionName: 'getPendingMintRequest', args: [address, cycle] });
    } else {
      readConfigs.push({ address: contract, abi: kashYieldABI, functionName: 'getPendingRedeemRequest', args: [address, cycle] });
    }
    activityToConfigIndex[i] = batchIdx;
  });
  const { data: readResults } = useReadContracts({
    contracts: readConfigs,
    query: { enabled: readConfigs.length > 0 },
  });
  const canCancelByIndex = new Map<number, boolean>();
  const cancelledByIndex = new Map<number, boolean>();
  const processedByIndex = new Map<number, boolean>();
  if (readResults && address) {
    type BatchResult = { status: 'success'; result: readonly [bigint, bigint, boolean, bigint, bigint] };
    type PendingResult = { status: 'success'; result: { amountIn?: bigint; kashAmount?: bigint } };
    for (let i = 0; i < activities.length; i++) {
      const batchIdx = activityToConfigIndex[i];
      if (batchIdx === undefined) continue;
      const batchR = readResults[batchIdx] as BatchResult | undefined;
      const pendingR = readResults[batchIdx + 1] as PendingResult | undefined;
      const processed = batchR?.status === 'success' && batchR.result
        ? batchR.result[2]
        : true;
      const hasRequest = pendingR?.status === 'success' && pendingR.result
        ? activities[i].type === 'mint'
          ? (pendingR.result.amountIn ?? 0n) > 0n
          : (pendingR.result.kashAmount ?? 0n) > 0n
        : false;
      canCancelByIndex.set(i, !processed && hasRequest);
      cancelledByIndex.set(i, !processed && !hasRequest);
      processedByIndex.set(i, processed);
    }
  }

  const writeContractResult = useWriteContract();
  const { writeContract: writeCancel, data: cancelTxHash, isPending: isCancelPending, error: cancelError } = writeContractResult;
  const resetWrite = 'reset' in writeContractResult ? (writeContractResult as { reset: () => void }).reset : () => {};

  const { isLoading: isCancelConfirming, isSuccess: isCancelSuccess, isError: isCancelReceiptError, data: cancelReceipt } = useWaitForTransactionReceipt({ hash: cancelTxHash });

  const [cancelFeedback, setCancelFeedback] = useState<{ type: 'error' | 'success'; message: string } | null>(null);

  const { data: feesPerGas } = useEstimateFeesPerGas();
  const gasOptions = useMemo(() => {
    const raw = feesPerGas?.maxFeePerGas;
    if (raw != null && raw > 0n) {
      const withBuffer = (raw * 110n) / 100n;
      return {
        maxFeePerGas: withBuffer,
        maxPriorityFeePerGas: feesPerGas?.maxPriorityFeePerGas ?? withBuffer,
      };
    }
    return {
      maxFeePerGas: FALLBACK_MAX_FEE_WEI,
      maxPriorityFeePerGas: FALLBACK_MAX_FEE_WEI,
    };
  }, [feesPerGas?.maxFeePerGas, feesPerGas?.maxPriorityFeePerGas]);

  // When cancel tx confirms: success → refetch and clear; reverted → show error
  useEffect(() => {
    if (!cancelTxHash || isCancelConfirming) return;
    if (isCancelReceiptError || cancelReceipt?.status === 'reverted') {
      setCancelTarget(null);
      setCancelFeedback({
        type: 'error',
        message: 'Cancel failed (transaction reverted). The contract may not have enough wBTC—e.g. it was moved to Aave. Ask the owner to run the ownerWithdrawFromAave script first, then try again.',
      });
      resetWrite();
      return;
    }
    if (isCancelSuccess && cancelReceipt?.status === 'success') {
      setCancelTarget(null);
      setCancelFeedback({ type: 'success', message: 'Cancel confirmed. Your wBTC has been returned to your wallet.' });
      load();
      resetWrite();
    }
  }, [cancelTxHash, isCancelConfirming, isCancelSuccess, isCancelReceiptError, cancelReceipt?.status, load]);

  // When user rejects tx in wallet, clear target and show message
  useEffect(() => {
    if (!isCancelPending && !cancelTxHash && cancelTarget) {
      setCancelTarget(null);
    }
  }, [isCancelPending, cancelTxHash, cancelTarget]);

  const handleCancelMint = (item: ActivityItem) => {
    if (item.contractAddress == null || item.batchCycle == null) return;
    setCancelFeedback(null);
    setCancelTarget({ contractAddress: item.contractAddress, batchCycle: item.batchCycle, type: 'mint' });
    writeCancel({
      address: item.contractAddress as `0x${string}`,
      abi: kashYieldABI,
      functionName: 'cancelMintRequest',
      args: [BigInt(item.batchCycle)],
      ...gasOptions,
    });
  };

  const handleCancelRedeem = (item: ActivityItem) => {
    if (item.contractAddress == null || item.batchCycle == null) return;
    setCancelFeedback(null);
    setCancelTarget({ contractAddress: item.contractAddress, batchCycle: item.batchCycle, type: 'redeem' });
    writeCancel({
      address: item.contractAddress as `0x${string}`,
      abi: kashYieldABI,
      functionName: 'cancelRedeemRequest',
      args: [BigInt(item.batchCycle)],
      ...gasOptions,
    });
  };

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

      {(cancelError || cancelFeedback) && (
        <div
          className={`mb-4 p-3 rounded-lg text-sm ${
            cancelFeedback?.type === 'success'
              ? 'bg-green-50 border border-green-200 text-green-800'
              : 'bg-red-50 border border-red-200 text-red-800'
          }`}
        >
          {cancelError?.message ?? cancelFeedback?.message}
          {cancelTxHash && (
            <span className="block mt-1">
              <a
                href={`${ARBITRUM_SEPOLIA_BLOCK_EXPLORER}/tx/${cancelTxHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                View transaction
              </a>
            </span>
          )}
          <button
            type="button"
            onClick={() => { setCancelFeedback(null); resetWrite(); }}
            className="mt-2 text-xs underline"
          >
            Dismiss
          </button>
        </div>
      )}

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
          {activities.map((item, i) => {
            const canCancel = canCancelByIndex.get(i) ?? false;
            const cancelled = cancelledByIndex.get(i) ?? false;
            const processed = processedByIndex.get(i) ?? false;
            const isCancellingThis = cancelTarget?.contractAddress === item.contractAddress &&
              cancelTarget?.batchCycle === item.batchCycle &&
              cancelTarget?.type === item.type;
            const isBtcContract = item.contractAddress?.toLowerCase() === (CONTRACTS.kashYieldBtc as string).toLowerCase();
            const mintedLabel = item.type === 'mint' && processed
              ? (isBtcContract ? 'Kash-BTC minted' : 'Kash-ETH minted')
              : null;

            return (
              <li
                key={item.hash}
                className="flex items-center justify-between gap-2 py-2 px-3 rounded-lg border border-gray-100 hover:bg-gray-50/50 transition flex-wrap"
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
                {mintedLabel && (
                  <span className="text-xs font-medium text-green-600 shrink-0">
                    {mintedLabel}
                  </span>
                )}
                {canCancel && (
                  <button
                    type="button"
                    onClick={() => item.type === 'mint' ? handleCancelMint(item) : handleCancelRedeem(item)}
                    disabled={isCancelPending || isCancellingThis}
                    className="text-xs font-medium text-amber-700 hover:text-amber-800 border border-amber-300 hover:border-amber-400 rounded px-2 py-1 shrink-0 disabled:opacity-50 disabled:cursor-not-allowed transition"
                  >
                    {isCancellingThis ? 'Cancelling…' : item.type === 'mint' ? 'Cancel mint' : 'Cancel redeem'}
                  </button>
                )}
                {cancelled && (
                  <span className="text-xs font-medium text-gray-600 shrink-0">
                    Transaction cancelled
                  </span>
                )}
                <span className="text-xs text-gray-500 shrink-0">{formatTimeAgo(item.timestamp)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
