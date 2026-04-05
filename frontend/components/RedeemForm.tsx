'use client';

import { useState, useMemo, useEffect, useCallback } from 'react';
import { useWriteContract, useWaitForTransactionReceipt, useAccount, useReadContract, useEstimateFeesPerGas } from 'wagmi';
import { CONTRACTS, ARBITRUM_ONE_BLOCK_EXPLORER, HARDHAT_CHAIN_ID } from '@/lib/contracts/addresses';
import { kashYieldABI } from '@/lib/contracts/kashYieldABI';
import { kashTokenABI } from '@/lib/contracts/kashTokenABI';
import { parseEther, formatEther } from 'viem';
import { useChainId } from 'wagmi';

const MIN_MAX_FEE_GWEI = 30n;
const GWEI = 10n ** 9n;
const FEE_BUFFER_PERCENT = 120n;

type Product = 'eth' | 'btc';

export function RedeemForm({ product = 'eth' }: { product?: Product }) {
  const { address } = useAccount();
  const chainId = useChainId();

  const isBtc = product === 'btc' && CONTRACTS.kashYieldBtc && CONTRACTS.kashTokenBtc;
  const kashYield = isBtc ? CONTRACTS.kashYieldBtc! : CONTRACTS.kashYieldEth;
  const kashToken = isBtc ? CONTRACTS.kashTokenBtc! : CONTRACTS.kashTokenEth;
  const redeemSymbol = isBtc ? 'KASH-BTC' : 'KASH-ETH';
  const [amount, setAmount] = useState('');
  const [hideSettled, setHideSettled] = useState(false);
  const [hadPendingBeforeBatch, setHadPendingBeforeBatch] = useState(false);

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
    query: { refetchInterval: 15000 },
  });

  const { data: cycleDurationSecondsRaw } = useReadContract({
    address: kashYield,
    abi: kashYieldABI,
    functionName: 'cycleDurationSeconds',
  });
  const cycleDuration = cycleDurationSecondsRaw !== undefined ? Number(cycleDurationSecondsRaw) : 86400;
  const isShortCycle = cycleDuration < 86400;

  const { data: pendingRedeemRequest, refetch: refetchPendingRedeem } = useReadContract({
    address: kashYield,
    abi: kashYieldABI,
    functionName: 'getPendingRedeemRequest',
    args: address && currentBatchCycle !== undefined ? [address, currentBatchCycle] : undefined,
    query: { refetchInterval: 15000 },
  });

  // Only treat as processed when we have batch info; otherwise show pending/cancel state
  const batchProcessed = batchInfo ? (batchInfo as readonly [bigint, bigint, boolean, bigint, bigint])[2] : false;
  const canCancelRedeem = Boolean(
    address &&
    currentBatchCycle !== undefined &&
    batchInfo &&
    !batchProcessed &&
    pendingRedeemRequest &&
    pendingRedeemRequest.kashAmount > 0n
  );

  // localStorage key scoped to wallet + cycle + product so it persists across page refreshes
  const pendingStorageKey = useMemo(
    () => address && currentBatchCycle !== undefined
      ? `kash-redeem-pending-${address}-${currentBatchCycle}-${product}`
      : null,
    [address, currentBatchCycle, product]
  );

  // Load persisted flag on mount / when cycle changes
  useEffect(() => {
    if (!pendingStorageKey) return;
    setHadPendingBeforeBatch(localStorage.getItem(pendingStorageKey) === '1');
  }, [pendingStorageKey]);

  // Record that a pre-batch request exists the moment the cancel button becomes available
  useEffect(() => {
    if (canCancelRedeem && pendingStorageKey) {
      localStorage.setItem(pendingStorageKey, '1');
      setHadPendingBeforeBatch(true);
    }
  }, [canCancelRedeem, pendingStorageKey]);

  // "settled" = batch ran AND we have proof the request was submitted before the batch ran
  const redeemSettled = batchProcessed && hadPendingBeforeBatch && Boolean(pendingRedeemRequest?.kashAmount && pendingRedeemRequest.kashAmount > 0n);

  const { writeContract: approve, data: approveHash, isPending: isApprovePending } = useWriteContract();
  const { writeContract: redeem, data: redeemHash, isPending: isRedeemPending } = useWriteContract();
  const { writeContract: cancelRedeem, data: cancelRedeemHash, isPending: isCancelRedeemPending } = useWriteContract();

  const { isLoading: isApproveConfirming, isSuccess: isApproveSuccess } = useWaitForTransactionReceipt({ hash: approveHash });
  const { isLoading: isRedeemConfirming, isSuccess: isRedeemSuccess } = useWaitForTransactionReceipt({ hash: redeemHash });
  const { isLoading: isCancelRedeemConfirming } = useWaitForTransactionReceipt({ hash: cancelRedeemHash });

  const parsedAmount = amount ? parseEther(amount) : BigInt(0);
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
    }
  }, [isRedeemSuccess, refetchPendingRedeem]);

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

    redeem({
      address: kashYield,
      abi: kashYieldABI,
      functionName: 'requestRedeem',
      args: [parsedAmount],
      ...gasOptions,
    });
  };

  const handleCancelRedeem = () => {
    if (currentBatchCycle === undefined) return;
    cancelRedeem({
      address: kashYield,
      abi: kashYieldABI,
      functionName: 'cancelRedeemRequest',
      args: [currentBatchCycle],
      ...gasOptions,
    });
  };

  const handleMaxClick = () => {
    if (kashBalance) {
      setAmount(formatEther(kashBalance));
    }
  };

  if (isRedeemSuccess && amount && redeemHash) {
    const txUrl = `${ARBITRUM_ONE_BLOCK_EXPLORER}/tx/${redeemHash}`;
    return (
      <div className="text-center py-8">
        <div className="w-16 h-16 bg-purple-100 rounded-full flex items-center justify-center mx-auto mb-4">
          <svg className="w-8 h-8 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h3 className="text-lg font-semibold text-gray-900 mb-2">Redeem Request Submitted!</h3>
        <p className="text-sm text-gray-600 mb-4">
          Your request will be processed in the next batch cycle (23:50 UTC).
        </p>

        <div className="rounded-xl p-4 mb-6 border border-gray-200 bg-purple-50 shadow-md text-left space-y-2">
          <p className="text-sm font-medium text-gray-700">Request summary</p>
          <p className="text-sm text-gray-600">
            You requested to redeem <span className="font-semibold text-purple-600">{amount} {redeemSymbol}</span>
          </p>
          <p className="text-sm text-gray-600">
            Transaction:{' '}
            <a
              href={txUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-purple-600 hover:text-purple-700 font-mono text-xs break-all transition-colors"
            >
              {redeemHash.slice(0, 10)}…{redeemHash.slice(-8)}
            </a>
            <span className="text-gray-500 ml-1">(opens block explorer)</span>
          </p>
        </div>

        <button
          type="button"
          onClick={() => setAmount('')}
          className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors cursor-pointer"
        >
          Make Another Request
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
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


      {/* Settled redeem: success message */}
      {redeemSettled && !hideSettled && (
        <div className="rounded-lg border border-green-200 bg-green-50 p-3 flex items-start justify-between gap-2">
          <p className="text-sm text-green-800 font-medium">Your redeem request for this batch has been settled! Assets have been returned to your wallet.</p>
          <button
            type="button"
            onClick={() => {
              setHideSettled(true);
              if (pendingStorageKey) localStorage.removeItem(pendingStorageKey);
              setHadPendingBeforeBatch(false);
            }}
            className="text-green-600 hover:text-green-800 transition shrink-0 cursor-pointer"
            aria-label="Dismiss"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* Pending redeem: Cancel button */}
      {canCancelRedeem && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
          <p className="text-sm text-amber-800 mb-2">You have a pending redeem request for this batch cycle.</p>
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
          onClick={handleRedeem}
          disabled={isRedeemPending || isRedeemConfirming || !amount || needsApproval || (kashBalance !== undefined && parsedAmount > kashBalance)}
          className="w-full px-6 py-3 bg-linear-to-r from-purple-600 to-pink-600 text-white rounded-lg font-medium hover:from-purple-700 hover:to-pink-700 disabled:from-gray-300 disabled:to-gray-400 disabled:cursor-not-allowed cursor-pointer transition-all shadow-lg"
        >
          {isRedeemPending || isRedeemConfirming ? 'Processing...' : 'Submit Redeem Request'}
        </button>
      </div>

      {/*<p className="text-xs text-gray-500 text-center">
        Fee: 0.03% | Processed at next batch (23:50 UTC)
      </p>*/}
    </div>
  );
}
