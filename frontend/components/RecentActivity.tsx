'use client';

import { useAccount, useReadContracts, useWriteContract, useWaitForTransactionReceipt, useEstimateFeesPerGas, useReadContract } from 'wagmi';
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { ARBITRUM_ONE_CHAIN_ID, ARBITRUM_ONE_BLOCK_EXPLORER, CONTRACTS } from '@/lib/contracts/addresses';
import { kashYieldABI } from '@/lib/contracts/kashYieldABI';

const ACTIVITY_REFRESH_EVENT = 'kash-activity-refresh';

const COMPACT_ACTIVITY_LIMIT = 5;
const PAGE_ACTIVITY_SIZE = 10;

type ActivityItem = {
  type: 'mint' | 'redeem';
  hash: string;
  timestamp: number;
  blockNumber: string;
  batchCycle?: number;
  contractAddress?: string;
};

async function fetchActivity(
  address: string,
  cycleDuration: number,
  skip: number,
  limit: number,
): Promise<{ list: ActivityItem[]; error?: string; hasMore: boolean }> {
  const res = await fetch(
    `/api/activity?address=${encodeURIComponent(address)}&skip=${skip}&limit=${limit}&cycleDuration=${cycleDuration}&_=${Date.now()}`,
    { cache: 'no-store' }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return {
      list: [],
      error: data.error || 'Failed to load activity',
      hasMore: false,
    };
  }
  return {
    list: data.activities ?? [],
    error: data.error,
    hasMore: Boolean(data.hasMore),
  };
}

function cancelSuccessMessage(
  type: 'mint' | 'redeem',
  contractAddress: string | undefined,
): string {
  const addr = contractAddress?.toLowerCase();
  const btcAddr = CONTRACTS.kashYieldBtc?.toLowerCase();
  const isBtc = !!(btcAddr && addr === btcAddr);
  if (type === 'mint') {
    if (isBtc) return 'Cancel confirmed. Your wBTC has been returned to your wallet.';
    return 'Cancel confirmed. Your eth has been returned to your wallet.';
  }
  if (isBtc) return 'Cancel confirmed. Your KASH-BTC has been returned to your wallet.';
  return 'Cancel confirmed. Your KASH-ETH has been returned to your wallet.';
}

// Fallback max fee when estimate is missing (e.g. 25 gwei on L2)
const FALLBACK_MAX_FEE_WEI = 25n * (10n ** 9n);

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
  const isArbitrumOne = chainId === ARBITRUM_ONE_CHAIN_ID;

  const [activities, setActivities] = useState<ActivityItem[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [compactActivityView, setCompactActivityView] = useState(true);
  const [activityPage, setActivityPage] = useState(1);
  const [hasMoreActivities, setHasMoreActivities] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<{ contractAddress: string; batchCycle: number; type: 'mint' | 'redeem' } | null>(null);
  /** Set when user submits a cancel tx; used on receipt so message is correct even if cancelTarget is cleared before the effect runs again. */
  const cancelFeedbackContextRef = useRef<{ type: 'mint' | 'redeem'; contractAddress: string } | null>(null);

  // Tracks which tx hashes were ever cancel-eligible (submitted before their batch ran).
  // Persisted in localStorage so it survives page refreshes.
  const [cancelEligibleHashes, setCancelEligibleHashes] = useState<Set<string>>(() => {
    if (typeof window === 'undefined') return new Set<string>();
    try { return new Set<string>(JSON.parse(localStorage.getItem('kash-cancel-eligible-hashes') || '[]')); }
    catch { return new Set<string>(); }
  });

  // Read cycle duration from each contract so the API uses the correct batch cycle calculation
  const { data: ethCycleDurationRaw } = useReadContract({
    address: CONTRACTS.kashYieldEth,
    abi: kashYieldABI,
    functionName: 'cycleDurationSeconds',
  });
  const { data: btcCycleDurationRaw } = useReadContract({
    address: CONTRACTS.kashYieldBtc as `0x${string}` | undefined,
    abi: kashYieldABI,
    functionName: 'cycleDurationSeconds',
    query: { enabled: !!CONTRACTS.kashYieldBtc },
  });
  // Use the minimum of the two durations so the API resolution covers both contracts
  const cycleDuration = Math.min(
    ethCycleDurationRaw ? Number(ethCycleDurationRaw) : 86400,
    btcCycleDurationRaw ? Number(btcCycleDurationRaw) : 86400,
  );

  const load = useCallback(async () => {
    if (!address) return;
    setIsLoading(true);
    setLoadError(null);
    try {
      const skip = compactActivityView ? 0 : (activityPage - 1) * PAGE_ACTIVITY_SIZE;
      const limit = compactActivityView ? COMPACT_ACTIVITY_LIMIT : PAGE_ACTIVITY_SIZE;
      const { list, error, hasMore } = await fetchActivity(address, cycleDuration, skip, limit);
      setActivities(list);
      setHasMoreActivities(hasMore);
      setLoadError(error ?? null);
    } finally {
      setIsLoading(false);
    }
  }, [address, cycleDuration, compactActivityView, activityPage]);

  const loadLatest = useCallback(async () => {
    if (!address) return;
    setIsLoading(true);
    setLoadError(null);
    try {
      const { list, error, hasMore } = await fetchActivity(
        address,
        cycleDuration,
        0,
        COMPACT_ACTIVITY_LIMIT,
      );
      setActivities(list);
      setHasMoreActivities(hasMore);
      setLoadError(error ?? null);
    } finally {
      setIsLoading(false);
    }
  }, [address, cycleDuration]);

  useEffect(() => {
    if (address && isArbitrumOne) load();
    else {
      setActivities([]);
      setLoadError(null);
      setHasMoreActivities(false);
      setCompactActivityView(true);
      setActivityPage(1);
    }
  }, [address, isArbitrumOne, load]);

  // For each activity: getBatchInfo (processed?) and getPendingMintRequest/getPendingRedeemRequest (still has request?)
  const readConfigs: { address: `0x${string}`; abi: typeof kashYieldABI; functionName: 'getBatchInfo' | 'getPendingMintRequest' | 'getPendingRedeemRequest'; args: [bigint] | [string, bigint] }[] = [];
  const activityToConfigIndex: number[] = [];
  const activityToConfigIndexRef = useRef<number[]>([]);
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
  activityToConfigIndexRef.current = activityToConfigIndex;

  const { data: readResults, refetch: refetchOnChain } = useReadContracts({
    contracts: readConfigs,
    query: { enabled: readConfigs.length > 0, refetchInterval: 15000 },
  });
  const canCancelByIndex = new Map<number, boolean>();
  const cancelledByIndex = new Map<number, boolean>();
  const processedByIndex = new Map<number, boolean>();
  const hasRequestByIndex = new Map<number, boolean>();
  if (readResults && address) {
    type BatchResult = { status: 'success'; result: readonly [bigint, bigint, boolean, bigint, bigint] };
    type PendingResult = { status: 'success'; result: { amountIn?: bigint; kashAmount?: bigint } };
    for (let i = 0; i < activities.length; i++) {
      const batchIdx = activityToConfigIndex[i];
      if (batchIdx === undefined) continue;
      const batchR = readResults[batchIdx] as BatchResult | undefined;
      const pendingR = readResults[batchIdx + 1] as PendingResult | undefined;
      // Only treat as processed when we have a successful batch result; otherwise show pending/cancel state
      const processed = batchR?.status === 'success' && batchR.result
        ? batchR.result[2]
        : false;
      const hasRequest = pendingR?.status === 'success' && pendingR.result
        ? activities[i].type === 'mint'
          ? (pendingR.result.amountIn ?? 0n) > 0n
          : (pendingR.result.kashAmount ?? 0n) > 0n
        : false;
      canCancelByIndex.set(i, !processed && hasRequest);
      // Only show "Transaction cancelled" when we've positively confirmed it was once pending
      // (hash is in cancelEligibleHashes) but the request is now gone without the batch running.
      // Without that localStorage evidence we can't distinguish a cancelled tx from a batch-cycle
      // mismatch, so we stay silent rather than show a false "cancelled" label.
      cancelledByIndex.set(
        i,
        !processed && pendingR?.status === 'success' && !hasRequest && cancelEligibleHashes.has(activities[i]?.hash ?? ''),
      );
      processedByIndex.set(i, processed);
      hasRequestByIndex.set(i, hasRequest);
    }
  }

  // When a transaction becomes cancel-eligible (submitted before batch ran), record its hash
  // in localStorage so we can still show "settled" correctly after a page refresh.
  useEffect(() => {
    if (!readResults || !address || activities.length === 0) return;
    const indexMap = activityToConfigIndexRef.current;
    setCancelEligibleHashes(prev => {
      const updated = new Set(prev);
      let changed = false;
      type BatchResult = { status: 'success'; result: readonly [bigint, bigint, boolean, bigint, bigint] };
      type PendingResult = { status: 'success'; result: { amountIn?: bigint; kashAmount?: bigint } };
      for (let i = 0; i < activities.length; i++) {
        const batchIdx = indexMap[i];
        if (batchIdx === undefined) continue;
        const batchR = readResults[batchIdx] as BatchResult | undefined;
        const pendingR = readResults[batchIdx + 1] as PendingResult | undefined;
        const processed = batchR?.status === 'success' && batchR.result ? batchR.result[2] : false;
        const hasRequest = pendingR?.status === 'success' && pendingR.result
          ? activities[i].type === 'mint'
            ? (pendingR.result.amountIn ?? 0n) > 0n
            : (pendingR.result.kashAmount ?? 0n) > 0n
          : false;
        // Add hash when there is a request (pending or already processed) so we can show
        // "Kash-BTC minted" / "wBTC redeemed" after batch runs, even if the user didn't
        // have the page open while it was still pending.
        if (hasRequest && !updated.has(activities[i].hash)) {
          updated.add(activities[i].hash);
          changed = true;
        }
      }
      if (changed) {
        localStorage.setItem('kash-cancel-eligible-hashes', JSON.stringify([...updated]));
        return updated;
      }
      return prev;
    });
  }, [readResults, activities, address]);

  // Combined refresh: re-fetch Etherscan activity list AND re-read on-chain batch/pending state
  const handleRefresh = useCallback(async () => {
    await load();
    refetchOnChain();
  }, [load, refetchOnChain]);

  useEffect(() => {
    const onExternalRefresh = () => {
      setCompactActivityView(true);
      setActivityPage(1);
      void loadLatest().then(() => {
        refetchOnChain();
      });
    };
    window.addEventListener(ACTIVITY_REFRESH_EVENT, onExternalRefresh);
    return () => window.removeEventListener(ACTIVITY_REFRESH_EVENT, onExternalRefresh);
  }, [loadLatest, refetchOnChain]);

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
      cancelFeedbackContextRef.current = null;
      setCancelTarget(null);
      setCancelFeedback({
        type: 'error',
        message: 'Cancel failed (transaction reverted). The contract may not have enough wBTC—e.g. it was moved to Aave. Ask the owner to run the ownerWithdrawFromAave script first, then try again.',
      });
      resetWrite();
      return;
    }
    if (isCancelSuccess && cancelReceipt?.status === 'success') {
      const ctx = cancelFeedbackContextRef.current;
      cancelFeedbackContextRef.current = null;
      const message = ctx
        ? cancelSuccessMessage(ctx.type, ctx.contractAddress)
        : 'Cancel confirmed.';
      setCancelTarget(null);
      setCancelFeedback({ type: 'success', message });
      load();
      resetWrite();
    }
  }, [cancelTxHash, isCancelConfirming, isCancelSuccess, isCancelReceiptError, cancelReceipt?.status, load, resetWrite]);

  // When user rejects tx in wallet, clear target and show message
  useEffect(() => {
    if (!isCancelPending && !cancelTxHash && cancelTarget) {
      setCancelTarget(null);
    }
  }, [isCancelPending, cancelTxHash, cancelTarget]);

  const handleCancelMint = (item: ActivityItem, resolvedCycle: number) => {
    if (item.contractAddress == null) return;
    setCancelFeedback(null);
    cancelFeedbackContextRef.current = { type: 'mint', contractAddress: item.contractAddress };
    setCancelTarget({ contractAddress: item.contractAddress, batchCycle: resolvedCycle, type: 'mint' });
    writeCancel({
      address: item.contractAddress as `0x${string}`,
      abi: kashYieldABI,
      functionName: 'cancelMintRequest',
      args: [BigInt(resolvedCycle)],
      ...gasOptions,
    });
  };

  const handleCancelRedeem = (item: ActivityItem, resolvedCycle: number) => {
    if (item.contractAddress == null) return;
    setCancelFeedback(null);
    cancelFeedbackContextRef.current = { type: 'redeem', contractAddress: item.contractAddress };
    setCancelTarget({ contractAddress: item.contractAddress, batchCycle: resolvedCycle, type: 'redeem' });
    writeCancel({
      address: item.contractAddress as `0x${string}`,
      abi: kashYieldABI,
      functionName: 'cancelRedeemRequest',
      args: [BigInt(resolvedCycle)],
      ...gasOptions,
    });
  };

  if (!address || !isArbitrumOne) return null;

  return (
    <div className="rounded-2xl border bg-white shadow-xl p-6 mt-8" style={{ borderColor: 'rgba(0, 255, 255, 0.2)' }}>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold text-gray-900">Recent Activity</h2>
        <button
          type="button"
          onClick={handleRefresh}
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
                href={`${ARBITRUM_ONE_BLOCK_EXPLORER}/tx/${cancelTxHash}`}
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
        <>
          <ul className="space-y-2">
            {activities.map((item, i) => {
              const canCancel = canCancelByIndex.get(i) ?? false;
              const cancelled = cancelledByIndex.get(i) ?? false;
              const processed = processedByIndex.get(i) ?? false;
              const isCancellingThis = cancelTarget?.contractAddress === item.contractAddress &&
                cancelTarget?.batchCycle === item.batchCycle &&
                cancelTarget?.type === item.type;
              const isBtcContract = item.contractAddress?.toLowerCase() === (CONTRACTS.kashYieldBtc as string).toLowerCase();
              const hasReq = hasRequestByIndex.get(i) ?? false;
              // Only show settled label when: batch ran AND request existed before batch ran
              // (cancelEligibleHashes tracks hashes we observed as cancellable, i.e. pre-batch)
              const settledLabel = processed && hasReq && cancelEligibleHashes.has(item.hash)
                ? item.type === 'mint'
                  ? (isBtcContract ? 'Kash-BTC minted' : 'Kash-ETH minted')
                  : (isBtcContract ? 'wBTC redeemed' : 'ETH redeemed')
                : null;
              // Request exists on-chain and is waiting for the batch to run
              const isPending = !processed && hasReq;

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
                    href={`${ARBITRUM_ONE_BLOCK_EXPLORER}/tx/${item.hash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-xs text-gray-600 hover:text-indigo-600 truncate flex-1 min-w-0"
                    title={item.hash}
                  >
                    {item.hash.slice(0, 10)}…{item.hash.slice(-8)}
                  </a>
                  {settledLabel && (
                    <span className="text-xs font-medium text-green-600 shrink-0">
                      {settledLabel}
                    </span>
                  )}
                  {canCancel && (
                    <button
                      type="button"
                      onClick={() => item.type === 'mint' ? handleCancelMint(item, item.batchCycle ?? 0) : handleCancelRedeem(item, item.batchCycle ?? 0)}
                      disabled={isCancelPending || isCancellingThis}
                      className="text-xs font-medium text-amber-700 hover:text-amber-800 border border-amber-300 hover:border-amber-400 rounded px-2 py-1 shrink-0 disabled:opacity-50 disabled:cursor-not-allowed transition"
                    >
                      {isCancellingThis ? 'Cancelling…' : item.type === 'mint' ? 'Cancel mint' : 'Cancel redeem'}
                    </button>
                  )}
                  {isPending && !canCancel && (
                    <span className="text-xs font-medium text-amber-600 shrink-0">Pending</span>
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

          {compactActivityView && hasMoreActivities && (
            <div className="mt-4 flex justify-center">
              <button
                type="button"
                onClick={() => {
                  setCompactActivityView(false);
                  setActivityPage(1);
                }}
                className="text-sm font-medium text-indigo-600 hover:text-indigo-700 transition cursor-pointer"
              >
                Show more
              </button>
            </div>
          )}

          {!compactActivityView && (
            <div className="mt-4 flex flex-col sm:flex-row items-center justify-between gap-3 border-t border-gray-100 pt-4">
              <span className="text-xs text-gray-500">
                Page {activityPage}
                {activities.length > 0
                  ? ` · ${(activityPage - 1) * PAGE_ACTIVITY_SIZE + 1}–${(activityPage - 1) * PAGE_ACTIVITY_SIZE + activities.length}`
                  : ''}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setActivityPage((p) => Math.max(1, p - 1))}
                  disabled={activityPage <= 1 || isLoading}
                  className="px-3 py-1.5 text-sm rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition"
                >
                  Previous
                </button>
                <button
                  type="button"
                  onClick={() => setActivityPage((p) => p + 1)}
                  disabled={!hasMoreActivities || isLoading}
                  className="px-3 py-1.5 text-sm rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
