'use client';

import { useState, useMemo, useEffect } from 'react';
import { useWriteContract, useWaitForTransactionReceipt, useAccount, useReadContract, useReadContracts, useEstimateFeesPerGas, usePublicClient } from 'wagmi';
import { CONTRACTS, ARBITRUM_ONE_BLOCK_EXPLORER, HARDHAT_CHAIN_ID } from '@/lib/contracts/addresses';
import { kashYieldABI } from '@/lib/contracts/kashYieldABI';
import { kashTokenABI } from '@/lib/contracts/kashTokenABI';
import { usePendingBatchRequest, type PendingBatchRequest } from '@/lib/usePendingBatchRequest';
import { resolveClaimProof, formatClaimPayoutAmount } from '@/lib/redeemProofs';
import {
  BATCH_USER_CAP,
  type BatchInfoRow,
  batchCapNotice,
  isBatchProcessed,
  isNewUserBlockedByBatchCap,
  isRedeemCapReachedError,
  redeemUsersCountFromBatchInfo,
} from '@/lib/batchUserCap';
import { parseEther, formatEther } from 'viem';
import { useChainId } from 'wagmi';

function isUserRejectedWalletError(error: Error | null | undefined): boolean {
  if (!error) return false;
  const msg = `${error.name} ${error.message} ${error.cause instanceof Error ? error.cause.message : ''}`.toLowerCase();
  return (
    /user rejected|user denied|rejected the request|denied transaction signature|reject this request/i.test(msg) ||
    error.name === 'UserRejectedRequestError'
  );
}

function formatApproxUsd(usdWei18: bigint | null): string {
  if (usdWei18 === null) return '—';
  const n = Number(formatEther(usdWei18));
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const MIN_MAX_FEE_GWEI = 30n;
const GWEI = 10n ** 9n;
const FEE_BUFFER_PERCENT = 120n;

type Product = 'eth' | 'btc';

const ACTIVITY_REFRESH_EVENT = 'kash-activity-refresh';
const ACTIVITY_REFRESH_RETRY_DELAYS_MS = [0, 4000, 12000, 30000];

function dispatchActivityRefresh() {
  ACTIVITY_REFRESH_RETRY_DELAYS_MS.forEach((delay) => {
    window.setTimeout(() => {
      window.dispatchEvent(new Event(ACTIVITY_REFRESH_EVENT));
    }, delay);
  });
}

export function RedeemForm({ product = 'eth' }: { product?: Product }) {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const chainId = useChainId();

  const isBtc = product === 'btc' && CONTRACTS.kashYieldBtc && CONTRACTS.kashTokenBtc;
  const kashYield = isBtc ? CONTRACTS.kashYieldBtc! : CONTRACTS.kashYieldEth;
  const kashToken = isBtc ? CONTRACTS.kashTokenBtc! : CONTRACTS.kashTokenEth;
  const redeemSymbol = isBtc ? 'KASH-BTC' : 'KASH-ETH';
  const [amount, setAmount] = useState('');
  const [showRedeemConfirm, setShowRedeemConfirm] = useState(false);
  const [submittedRedeem, setSubmittedRedeem] = useState<{ hash: `0x${string}`; amount: string } | null>(null);
  const [lastActivityRefreshHash, setLastActivityRefreshHash] = useState<`0x${string}` | null>(null);
  const [claimingCycle, setClaimingCycle] = useState<string | null>(null);
  const [pendingClaimCycle, setPendingClaimCycle] = useState<bigint | null>(null);
  const [claimErrors, setClaimErrors] = useState<Record<string, string>>({});
  const [claimPayouts, setClaimPayouts] = useState<Record<string, bigint | null>>({});
  const claimAssetSymbol = isBtc ? 'wBTC' : 'ETH';

  const { data: feesPerGas } = useEstimateFeesPerGas();
  const gasOptions = useMemo(() => {
    const raw = feesPerGas?.maxFeePerGas ?? MIN_MAX_FEE_GWEI * GWEI;
    const withBuffer = (raw * FEE_BUFFER_PERCENT) / 100n;
    const minFee = MIN_MAX_FEE_GWEI * GWEI;
    const maxFeePerGas = withBuffer > minFee ? withBuffer : minFee;
    return {
      maxFeePerGas,
      maxPriorityFeePerGas: feesPerGas?.maxPriorityFeePerGas,
    };
  }, [feesPerGas?.maxFeePerGas, feesPerGas?.maxPriorityFeePerGas]);

  const { data: kashBalance } = useReadContract({
    address: kashToken,
    abi: kashTokenABI,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
  });

  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: kashToken,
    abi: kashTokenABI,
    functionName: 'allowance',
    args: address ? [address, kashYield] : undefined,
  });

  const { data: currentBatchCycle } = useReadContract({
    address: kashYield,
    abi: kashYieldABI,
    functionName: 'getCurrentBatchCycle',
  });

  const { data: batchInfo } = useReadContract({
    address: kashYield,
    abi: kashYieldABI,
    functionName: 'getBatchInfo',
    args: currentBatchCycle !== undefined ? [currentBatchCycle] : undefined,
    query: { refetchInterval: 15_000 },
  });

  const { data: currentNav, isFetched: navFetched } = useReadContract({
    address: kashYield,
    abi: kashYieldABI,
    functionName: 'currentNAV',
    query: { refetchInterval: 15_000 },
  });

  const {
    requests: redeemRequests,
    cancellable: cancellableRedeem,
    stuck: stuckRedeem,
    refetch: refetchPendingLookback,
  } = usePendingBatchRequest({
    kashYield,
    userAddress: address,
    currentBatchCycle,
    kind: 'redeem',
  });

  const processedRedeems = useMemo(
    () => redeemRequests.filter((r) => r.processed && r.amount > 0n),
    [redeemRequests],
  );

  const redeemClaimedContracts = useMemo(() => {
    if (!address || processedRedeems.length === 0) return [];
    return processedRedeems.map((r) => ({
      address: kashYield,
      abi: kashYieldABI,
      functionName: 'redeemClaimed' as const,
      args: [r.batchCycle, address] as const,
    }));
  }, [kashYield, address, processedRedeems]);

  const { data: redeemClaimedResults, refetch: refetchClaimStatuses } = useReadContracts({
    contracts: redeemClaimedContracts,
    query: {
      enabled: redeemClaimedContracts.length > 0,
      refetchInterval: 15_000,
    },
  });

  const claimableRedeems = useMemo((): PendingBatchRequest[] => {
    const unclaimed: PendingBatchRequest[] = [];
    for (let i = 0; i < processedRedeems.length; i++) {
      const req = processedRedeems[i];
      const claimed =
        redeemClaimedResults?.[i]?.status === 'success' &&
        redeemClaimedResults[i].result === true;
      if (!claimed) unclaimed.push(req);
    }
    return unclaimed.sort((a, b) => (a.batchCycle > b.batchCycle ? -1 : 1));
  }, [processedRedeems, redeemClaimedResults]);

  const needsClaim = claimableRedeems.length > 0;

  useEffect(() => {
    if (!address || claimableRedeems.length === 0) {
      setClaimPayouts({});
      return;
    }
    let cancelled = false;
    setClaimPayouts({});
    const loadPayouts = async () => {
      const entries = await Promise.all(
        claimableRedeems.map(async (req) => {
          const key = req.batchCycle.toString();
          const proof = await resolveClaimProof({
            product,
            batchCycle: req.batchCycle,
            userAddress: address,
            kashYield,
            publicClient,
          });
          return [key, proof && proof.amount > 0n ? proof.amount : null] as const;
        }),
      );
      if (!cancelled) {
        setClaimPayouts(Object.fromEntries(entries));
      }
    };
    void loadPayouts();
    return () => {
      cancelled = true;
    };
  }, [address, claimableRedeems, product, publicClient, kashYield]);

  const pendingRedeemCycle =
    cancellableRedeem?.batchCycle ??
    stuckRedeem?.batchCycle ??
    currentBatchCycle;

  const { data: paused } = useReadContract({
    address: kashYield,
    abi: kashYieldABI,
    functionName: 'paused',
    query: { refetchInterval: 15_000 },
  });

  const { data: pendingRedeemRequest, refetch: refetchPendingRedeem } = useReadContract({
    address: kashYield,
    abi: kashYieldABI,
    functionName: 'getPendingRedeemRequest',
    args: address && pendingRedeemCycle !== undefined ? [address, pendingRedeemCycle] : undefined,
    query: { refetchInterval: 15000 },
  });

  const { data: currentCycleRedeemRequest } = useReadContract({
    address: kashYield,
    abi: kashYieldABI,
    functionName: 'getPendingRedeemRequest',
    args: address && currentBatchCycle !== undefined ? [address, currentBatchCycle] : undefined,
    query: { refetchInterval: 15000 },
  });

  const batchInfoRow = batchInfo as BatchInfoRow | undefined;
  const batchProcessed = isBatchProcessed(batchInfoRow);
  const redeemUsersCount = redeemUsersCountFromBatchInfo(batchInfoRow);
  const userInCurrentRedeemBatch = (currentCycleRedeemRequest?.kashAmount ?? 0n) > 0n;
  const redeemBatchCapBlocked =
    isNewUserBlockedByBatchCap(redeemUsersCount, userInCurrentRedeemBatch) && !batchProcessed;

  const canCancelRedeem = Boolean(cancellableRedeem && cancellableRedeem.amount > 0n);
  const hasStuckRedeem = Boolean(stuckRedeem && stuckRedeem.amount > 0n);

  const { writeContract: approve, data: approveHash, isPending: isApprovePending } = useWriteContract();
  const redeemWriteResult = useWriteContract();
  const { writeContract: redeem, data: redeemHash, isPending: isRedeemPending, error: redeemError } = redeemWriteResult;
  const resetRedeem = 'reset' in redeemWriteResult ? (redeemWriteResult as { reset: () => void }).reset : () => {};
  const { writeContract: cancelRedeem, data: cancelRedeemHash, isPending: isCancelRedeemPending } = useWriteContract();
  const claimWrite = useWriteContract();
  const { writeContract: claimRedeem, data: claimHash, isPending: isClaimPending } = claimWrite;

  const { isLoading: isApproveConfirming, isSuccess: isApproveSuccess } = useWaitForTransactionReceipt({ hash: approveHash });
  const { isLoading: isRedeemConfirming, isSuccess: isRedeemSuccess, isError: isRedeemError } =
    useWaitForTransactionReceipt({ hash: redeemHash });
  const { isLoading: isCancelRedeemConfirming } = useWaitForTransactionReceipt({ hash: cancelRedeemHash });
  const { isLoading: isClaimConfirming, isSuccess: isClaimSuccess } = useWaitForTransactionReceipt({ hash: claimHash });

  const handleClaimRedeem = async (batchCycle: bigint) => {
    if (!address) return;
    const cycleKey = batchCycle.toString();
    setClaimErrors((prev) => {
      const next = { ...prev };
      delete next[cycleKey];
      return next;
    });
    setClaimingCycle(cycleKey);
    try {
      const proofData = await resolveClaimProof({
        product,
        batchCycle,
        userAddress: address,
        kashYield,
        publicClient,
      });
      if (!proofData) {
        setClaimErrors((prev) => ({
          ...prev,
          [cycleKey]: 'Could not build claim proof for this batch. Contact the operator.',
        }));
        setClaimingCycle(null);
        return;
      }
      setPendingClaimCycle(batchCycle);
      claimRedeem({
        address: kashYield,
        abi: kashYieldABI,
        functionName: 'claimRedeem',
        args: [batchCycle, proofData.amount, proofData.proof],
        ...gasOptions,
      });
    } catch (e) {
      setClaimErrors((prev) => ({
        ...prev,
        [cycleKey]: e instanceof Error ? e.message : 'Failed to load claim proof',
      }));
      setClaimingCycle(null);
      setPendingClaimCycle(null);
    }
  };

  const parsedAmount = amount ? parseEther(amount) : BigInt(0);

  const redeemApproxUsdWei18 = useMemo(() => {
    if (parsedAmount <= 0n || currentNav === undefined || currentNav <= 0n) return null;
    return (parsedAmount * currentNav) / 10n ** 18n;
  }, [parsedAmount, currentNav]);

  const redeemUsdLabel = formatApproxUsd(redeemApproxUsdWei18);

  const needsApproval = allowance !== undefined && parsedAmount > BigInt(0) && allowance < parsedAmount;

  // Refetch allowance after approve succeeds so UI updates and Submit Redeem Request becomes enabled
  useEffect(() => {
    if (isApproveSuccess && refetchAllowance) {
      refetchAllowance();
    }
  }, [isApproveSuccess, refetchAllowance]);

  // Refetch pending request after redeem confirms so cancel button and status update immediately
  useEffect(() => {
    if (isRedeemSuccess) {
      refetchPendingRedeem();
      refetchPendingLookback();
    }
  }, [isRedeemSuccess, refetchPendingRedeem, refetchPendingLookback]);

  useEffect(() => {
    if (isClaimSuccess) {
      setClaimingCycle(null);
      setPendingClaimCycle(null);
      refetchClaimStatuses();
      refetchPendingLookback();
      dispatchActivityRefresh();
    }
  }, [isClaimSuccess, refetchClaimStatuses, refetchPendingLookback]);

  useEffect(() => {
    if (isRedeemSuccess && redeemHash && amount && lastActivityRefreshHash !== redeemHash) {
      setSubmittedRedeem({ hash: redeemHash, amount });
      setLastActivityRefreshHash(redeemHash);
      dispatchActivityRefresh();
    }
  }, [isRedeemSuccess, redeemHash, amount, lastActivityRefreshHash]);

  useEffect(() => {
    if (!showRedeemConfirm) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowRedeemConfirm(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showRedeemConfirm]);

  const handleApprove = async () => {
    if (!parsedAmount) return;

    approve({
      address: kashToken,
      abi: kashTokenABI,
      functionName: 'approve',
      args: [kashYield, parsedAmount],
      ...gasOptions,
    });
  };

  const handleRedeem = async () => {
    if (!parsedAmount) return;
    setShowRedeemConfirm(false);

    redeem({
      address: kashYield,
      abi: kashYieldABI,
      functionName: 'requestRedeem',
      args: [parsedAmount],
      ...gasOptions,
    });
  };

  const handleCancelRedeem = () => {
    if (!cancellableRedeem) return;
    cancelRedeem({
      address: kashYield,
      abi: kashYieldABI,
      functionName: 'cancelRedeemRequest',
      args: [cancellableRedeem.batchCycle],
      ...gasOptions,
    });
  };

  const handleMaxClick = () => {
    if (kashBalance) {
      setAmount(formatEther(kashBalance));
    }
  };

  if (submittedRedeem && !needsClaim) {
    const txUrl = `${ARBITRUM_ONE_BLOCK_EXPLORER}/tx/${submittedRedeem.hash}`;
    return (
      <div className="text-center py-8">
        <div className="w-16 h-16 bg-purple-100 rounded-full flex items-center justify-center mx-auto mb-4">
          <svg className="w-8 h-8 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h3 className="text-lg font-semibold text-gray-900 mb-2">Redeem Request Submitted!</h3>
        <p className="text-sm text-gray-600 mb-4">
          Your request will be processed in the next batch cycle (23:45 UTC).
        </p>

        <div className="rounded-xl p-4 mb-6 border border-gray-200 bg-purple-50 shadow-md text-left space-y-2">
          <p className="text-sm font-medium text-gray-700">Request summary</p>
          <p className="text-sm text-gray-600">
            You requested to redeem <span className="font-semibold text-purple-600">{submittedRedeem.amount} {redeemSymbol}</span>
          </p>
          <p className="text-sm text-gray-600">
            Transaction:{' '}
            <a
              href={txUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-purple-600 hover:text-purple-700 font-mono text-xs break-all transition-colors"
            >
              {submittedRedeem.hash.slice(0, 10)}…{submittedRedeem.hash.slice(-8)}
            </a>
            <span className="text-gray-500 ml-1">(opens block explorer)</span>
          </p>
        </div>

        <button
          type="button"
          onClick={() => {
            setSubmittedRedeem(null);
            setAmount('');
            setShowRedeemConfirm(false);
            resetRedeem();
          }}
          className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors cursor-pointer"
        >
          Make Another Request
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4 relative">
      {showRedeemConfirm && (
        <div
          className="fixed inset-0 z-110 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="redeem-confirm-title"
        >
          <button
            type="button"
            className="absolute inset-0 cursor-pointer backdrop-blur-sm"
            style={{ backgroundColor: 'rgba(10, 10, 30, 0.82)' }}
            aria-label="Dismiss"
            onClick={() => setShowRedeemConfirm(false)}
          />
          <div
            className="relative z-111 bg-white rounded-2xl shadow-xl border max-w-md w-full p-6 text-left"
            style={{ borderColor: 'rgba(0, 255, 255, 0.22)', boxShadow: '0 10px 40px rgba(0, 0, 0, 0.45), 0 0 25px rgba(0, 255, 255, 0.08)' }}
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="w-9 h-9 bg-purple-100 rounded-lg flex items-center justify-center shrink-0 border border-transparent" style={{ boxShadow: '0 0 12px rgba(0, 255, 255, 0.12)' }}>
                <svg className="w-5 h-5 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
                </svg>
              </div>
              <h3 id="redeem-confirm-title" className="text-xl font-bold text-gray-900">
                Confirm redemption
              </h3>
            </div>
            <p className="text-sm text-gray-600 leading-relaxed">
              You are redeeming{' '}
              <span className="font-semibold text-gray-900">
                {amount} {redeemSymbol}
              </span>{' '}
              tokens currently valued at approximately{' '}
              <span className="font-semibold text-purple-600">${redeemUsdLabel}</span>
              {!navFetched && redeemApproxUsdWei18 === null && parsedAmount > 0n ? (
                <span className="text-gray-500"> (loading NAV…)</span>
              ) : null}
            </p>
            <p className="text-xs text-gray-500 mt-4 leading-relaxed">
              Value uses the contract&apos;s current NAV per token; settlement NAV may differ slightly after fees and slippage.
            </p>
            <div className="flex flex-col sm:flex-row gap-3 mt-6">
              <button
                type="button"
                onClick={() => setShowRedeemConfirm(false)}
                className="flex-1 px-6 py-3 rounded-lg font-medium transition border cursor-pointer bg-white/10 text-gray-400 hover:text-white border-white/20 hover:bg-white/15"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleRedeem()}
                disabled={isRedeemPending || isRedeemConfirming || redeemBatchCapBlocked}
                className="flex-1 px-6 py-3 rounded-lg bg-linear-to-r from-purple-600 to-pink-600 text-white font-medium hover:from-purple-700 hover:to-pink-700 disabled:from-gray-300 disabled:to-gray-400 disabled:cursor-not-allowed cursor-pointer transition-all shadow-lg disabled:shadow-none border-2 border-transparent"
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Token (single option per product) */}
      <div className="text-sm font-medium text-gray-700">
        Redeem: {redeemSymbol}
      </div>

      {/* Amount Input */}
      <div>
        <div className="flex justify-between items-center mb-2">
          <label className="block text-sm font-medium text-gray-700">KASH Amount</label>
          <button
            type="button"
            onClick={handleMaxClick}
            className="text-xs text-purple-600 hover:text-purple-700 font-medium cursor-pointer"
          >
            MAX: {kashBalance ? Number(formatEther(kashBalance)).toFixed(2) : '0.00'}
          </button>
        </div>
        <input
          type="number"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0.0"
          className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
        />
        {amount && parsedAmount > BigInt(0) && kashBalance !== undefined && parsedAmount > kashBalance && (
          <p className="text-sm text-red-600 mt-1.5">Insufficient {redeemSymbol} balance. Your balance: {Number(formatEther(kashBalance)).toFixed(4)}</p>
        )}
      </div>


      {/* Settled redeems: one claim action per batch */}
      {needsClaim && (
        <div className="rounded-lg border border-green-200 bg-green-50 p-3 space-y-3">
          <p className="text-sm text-green-800 font-medium">
            {claimableRedeems.length === 1
              ? `Your redeem for batch cycle ${claimableRedeems[0].batchCycle.toString()} is settled.`
              : `You have ${claimableRedeems.length} settled redeems ready to claim.`}
          </p>
          <ul className="space-y-2">
            {claimableRedeems.map((req) => {
              const cycleKey = req.batchCycle.toString();
              const isClaimingThis =
                claimingCycle === cycleKey ||
                (pendingClaimCycle === req.batchCycle && (isClaimPending || isClaimConfirming));
              const cycleError = claimErrors[cycleKey];
              return (
                <li
                  key={cycleKey}
                  className="kash-notice-nested rounded-md border border-green-200 p-3 space-y-2"
                >
                  <p className="text-sm text-gray-700">
                    <span className="font-medium text-green-800">Batch {cycleKey}</span>
                    {' · '}
                    {Number(formatEther(req.amount)).toFixed(4)} {redeemSymbol} redeemed
                    {claimPayouts[cycleKey] === undefined ? (
                      <span className="text-gray-500"> · loading {claimAssetSymbol} claim amount…</span>
                    ) : claimPayouts[cycleKey] !== null ? (
                      <>
                        {' · '}
                        <span className="font-medium text-green-800">
                          {formatClaimPayoutAmount(product, claimPayouts[cycleKey]!)} {claimAssetSymbol}
                        </span>
                        {' '}to claim
                      </>
                    ) : null}
                  </p>
                  {cycleError && <p className="text-sm text-red-700">{cycleError}</p>}
                  <button
                    type="button"
                    onClick={() => void handleClaimRedeem(req.batchCycle)}
                    disabled={isClaimingThis}
                    className="w-full px-4 py-2 bg-green-700 text-white rounded-lg text-sm font-medium hover:bg-green-800 disabled:bg-gray-300 disabled:cursor-not-allowed cursor-pointer transition-colors"
                  >
                    {isClaimingThis ? 'Claiming...' : `Claim ${isBtc ? 'wBTC' : 'ETH'}`}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Pending redeem: Cancel button */}
      {canCancelRedeem && cancellableRedeem && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
          <p className="text-sm text-amber-800 mb-2">
            You have a pending redeem request for batch cycle {cancellableRedeem.batchCycle.toString()} (
            {Number(formatEther(cancellableRedeem.amount)).toFixed(4)} {redeemSymbol}).
          </p>
          <button
            type="button"
            onClick={handleCancelRedeem}
            disabled={isCancelRedeemPending || isCancelRedeemConfirming}
            className="w-full px-4 py-2 bg-amber-600 text-white rounded-lg text-sm font-medium hover:bg-amber-700 disabled:bg-gray-300 disabled:cursor-not-allowed cursor-pointer transition-colors"
          >
            {isCancelRedeemPending || isCancelRedeemConfirming ? 'Cancelling...' : 'Cancel Redeem Request'}
          </button>
        </div>
      )}

      {/* Stuck redeem: batch started processing — cancel no longer possible */}
      {hasStuckRedeem && stuckRedeem && !canCancelRedeem && (
        <div className="rounded-lg border border-orange-200 bg-orange-50 p-3 space-y-2">
          <p className="text-sm text-orange-900 font-medium">
            Redeem in progress (batch cycle {stuckRedeem.batchCycle.toString()})
          </p>
          <p className="text-sm text-gray-600">
            {paused
              ? 'The protocol is paused — you can recover your KASH via emergencyWithdrawRedeem on the contract.'
              : `Your ${isBtc ? 'wBTC' : 'ETH'} will be sent to your wallet when the batch finishes. After settlement, claim from this form. If this stays stuck, contact the operator.`}
          </p>
          <p className="text-sm text-orange-800">
            {Number(formatEther(stuckRedeem.amount)).toFixed(4)} {redeemSymbol} is locked on the vault while the batch
            completes (phase {stuckRedeem.phase}). Cancellation is not available once processing has started.
          </p>
        </div>
      )}

      {redeemBatchCapBlocked && redeemUsersCount !== null && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
          <p className="text-sm font-medium text-amber-900">Redeem batch full</p>
          <p className="text-sm text-amber-800 mt-1">{batchCapNotice('redeem', redeemUsersCount)}</p>
        </div>
      )}

      {/* Action Buttons */}
      <div className="space-y-2">
        {needsApproval && (
          <button
            type="button"
            onClick={handleApprove}
            disabled={isApprovePending || isApproveConfirming || !amount}
            className="w-full px-6 py-3 bg-purple-600 text-white rounded-lg font-medium hover:bg-purple-700 disabled:bg-gray-300 disabled:cursor-not-allowed cursor-pointer transition-colors"
          >
            {isApprovePending || isApproveConfirming ? 'Approving...' : 'Approve KASH'}
          </button>
        )}
        
        <button
          type="button"
          onClick={() => setShowRedeemConfirm(true)}
          disabled={
            isRedeemPending ||
            isRedeemConfirming ||
            !amount ||
            needsApproval ||
            redeemBatchCapBlocked ||
            (kashBalance !== undefined && parsedAmount > kashBalance)
          }
          className="w-full px-6 py-3 bg-linear-to-r from-purple-600 to-pink-600 text-white rounded-lg font-medium hover:from-purple-700 hover:to-pink-700 disabled:from-gray-300 disabled:to-gray-400 disabled:cursor-not-allowed cursor-pointer transition-all shadow-lg"
        >
          {isRedeemPending || isRedeemConfirming ? 'Processing...' : 'Submit Redeem Request'}
        </button>
      </div>

      {(redeemError || isRedeemError) && (
        <div className="p-3 rounded-lg border border-red-200 bg-red-50 text-left">
          {isUserRejectedWalletError(redeemError) ? (
            <>
              <p className="text-sm font-medium text-red-800">Redeem request cancelled</p>
              <p className="text-xs text-red-600/90 mt-1.5 leading-relaxed">
                You closed the wallet prompt or declined the transaction. No funds were spent. Submit again when you are ready.
              </p>
            </>
          ) : isRedeemCapReachedError(redeemError) ? (
            <>
              <p className="text-sm font-medium text-red-800">Redeem batch full</p>
              <p className="text-xs text-red-600 mt-1.5 leading-relaxed">
                {redeemUsersCount !== null
                  ? batchCapNotice('redeem', redeemUsersCount)
                  : batchCapNotice('redeem', BATCH_USER_CAP)}
              </p>
            </>
          ) : (
            <>
              <p className="text-sm font-medium text-red-800">Transaction failed</p>
              <p className="text-xs text-red-600 mt-1.5 leading-relaxed">
                The redeem request could not be completed. Try again, or check your wallet for details.
              </p>
            </>
          )}
        </div>
      )}

      {/*<p className="text-xs text-gray-500 text-center">
        Fee: 0.05% | Processed at next batch (23:45 UTC)
      </p>*/}
    </div>
  );
}
