'use client';

import { useState, useMemo, useEffect } from 'react';
import { useWriteContract, useWaitForTransactionReceipt, useAccount, useReadContract, useBalance, useEstimateFeesPerGas } from 'wagmi';
import { CONTRACTS, ARBITRUM_ONE_BLOCK_EXPLORER, HARDHAT_CHAIN_ID } from '@/lib/contracts/addresses';
import { kashYieldABI } from '@/lib/contracts/kashYieldABI';
import { kashTokenABI } from '@/lib/contracts/kashTokenABI';
import { parseEther, parseUnits, formatEther, formatUnits, zeroAddress } from 'viem';
import { useChainId } from 'wagmi';

// Reserve this much native ETH for gas so wallet never sees "Insufficient funds" (deposit + gas > balance)
const GAS_RESERVE_ETH = parseEther('0.0005');

// Arbitrum One fallback when fee estimate is missing (1 gwei). Avoids wallets applying wrong-chain defaults.
const ARB_L2_FALLBACK_MAX_FEE_WEI = 10n ** 9n;

type Product = 'eth' | 'btc';

const ACTIVITY_REFRESH_EVENT = 'kash-activity-refresh';

function isUserRejectedWalletError(error: Error | null | undefined): boolean {
  if (!error) return false;
  const msg = `${error.name} ${error.message} ${error.cause instanceof Error ? error.cause.message : ''}`.toLowerCase();
  return (
    /user rejected|user denied|rejected the request|denied transaction signature|reject this request/i.test(msg) ||
    error.name === 'UserRejectedRequestError'
  );
}

const MINT_TOKEN_ETH = { symbol: 'ETH', address: zeroAddress, decimals: 18 };
const MINT_TOKEN_BTC = { symbol: 'wBTC', address: CONTRACTS.mockWbtc, decimals: 8 };

/** Truncate ETH amount to `decimals` fractional digits (no rounding up). */
function formatEtherDisplayDecimals(wei: bigint, decimals: number): string {
  if (decimals < 0 || decimals > 18) decimals = 6;
  const neg = wei < 0n;
  const w = neg ? -wei : wei;
  const whole = w / 10n ** 18n;
  const rem = w % 10n ** 18n;
  const scale = 10n ** BigInt(18 - decimals);
  const fracInt = rem / scale;
  const fracStr = fracInt.toString().padStart(decimals, '0');
  return `${neg ? '-' : ''}${whole.toString()}.${fracStr}`;
}

export function MintForm({ product = 'eth' }: { product?: Product }) {
  const { address } = useAccount();
  const chainId = useChainId();
  const blockExplorer = chainId === HARDHAT_CHAIN_ID ? 'http://localhost:8545' : ARBITRUM_ONE_BLOCK_EXPLORER;

  const isBtc = product === 'btc' && CONTRACTS.kashYieldBtc && CONTRACTS.mockWbtc;
  const kashYield = isBtc ? CONTRACTS.kashYieldBtc! : CONTRACTS.kashYieldEth;
  const depositToken = isBtc ? MINT_TOKEN_BTC : MINT_TOKEN_ETH;
  const [amount, setAmount] = useState('');
  const [hideSettled, setHideSettled] = useState(false);
  const [hadPendingBeforeBatch, setHadPendingBeforeBatch] = useState(false);

  const { data: balance } = useBalance({ address });
  const nativeBalance = balance?.value ?? 0n;
  const maxMintEth = nativeBalance > GAS_RESERVE_ETH ? nativeBalance - GAS_RESERVE_ETH : 0n;

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
      maxFeePerGas: ARB_L2_FALLBACK_MAX_FEE_WEI,
      maxPriorityFeePerGas: ARB_L2_FALLBACK_MAX_FEE_WEI,
    };
  }, [feesPerGas?.maxFeePerGas, feesPerGas?.maxPriorityFeePerGas]);

  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: depositToken.address as `0x${string}`,
    abi: kashTokenABI,
    functionName: 'allowance',
    args: address && depositToken.symbol !== 'ETH' ? [address, kashYield] : undefined,
  });

  const { data: wbtcBalance } = useBalance({
    address,
    token: isBtc ? (CONTRACTS.mockWbtc as `0x${string}`) : undefined,
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

  const { data: pendingMintRequest, refetch: refetchPendingMint } = useReadContract({
    address: kashYield,
    abi: kashYieldABI,
    functionName: 'getPendingMintRequest',
    args: address && currentBatchCycle !== undefined ? [address, currentBatchCycle] : undefined,
    query: { refetchInterval: 15000 },
  });

  // Only treat as processed when we have batch info; otherwise show pending/cancel state
  const batchProcessed = batchInfo ? (batchInfo as readonly [bigint, bigint, boolean, bigint, bigint])[2] : false;
  const canCancelMint = Boolean(
    address &&
    currentBatchCycle !== undefined &&
    batchInfo &&
    !batchProcessed &&
    pendingMintRequest &&
    pendingMintRequest.amountIn > 0n
  );

  // localStorage key scoped to wallet + cycle + product so it persists across page refreshes
  const pendingStorageKey = useMemo(
    () => address && currentBatchCycle !== undefined
      ? `kash-mint-pending-${address}-${currentBatchCycle}-${product}`
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
    if (canCancelMint && pendingStorageKey) {
      localStorage.setItem(pendingStorageKey, '1');
      setHadPendingBeforeBatch(true);
    }
  }, [canCancelMint, pendingStorageKey]);

  // "settled" = batch ran AND we have proof the request was submitted before the batch ran
  const mintSettled = batchProcessed && hadPendingBeforeBatch && Boolean(pendingMintRequest?.amountIn && pendingMintRequest.amountIn > 0n);

  const { writeContract: approve, data: approveHash, isPending: isApprovePending, error: approveError } = useWriteContract();
  const { writeContract: mint, data: mintHash, isPending: isMintPending, error: mintError } = useWriteContract();
  const { writeContract: cancelMint, data: cancelMintHash, isPending: isCancelMintPending } = useWriteContract();

  const { isLoading: isApproveConfirming, isSuccess: isApproveSuccess, isError: isApproveError } = useWaitForTransactionReceipt({ hash: approveHash });
  const { isLoading: isMintConfirming, isSuccess: isMintSuccess, isError: isMintError } = useWaitForTransactionReceipt({ hash: mintHash });
  const { isLoading: isCancelMintConfirming } = useWaitForTransactionReceipt({ hash: cancelMintHash });

  // Refetch allowance after approve succeeds so UI updates and Submit Mint Request becomes enabled
  useEffect(() => {
    if (isApproveSuccess && refetchAllowance) {
      refetchAllowance();
    }
  }, [isApproveSuccess, refetchAllowance]);

  // Refetch pending request after mint confirms so cancel button and status update immediately
  useEffect(() => {
    if (isMintSuccess) {
      refetchPendingMint();
    }
  }, [isMintSuccess, refetchPendingMint]);

  useEffect(() => {
    if (isMintSuccess && mintHash && amount) {
      window.dispatchEvent(new Event(ACTIVITY_REFRESH_EVENT));
    }
  }, [isMintSuccess, mintHash, amount]);

  const parsedAmount = amount ?
    (depositToken.symbol === 'ETH' ? parseEther(amount) : parseUnits(amount, depositToken.decimals))
    : BigInt(0);

  // For ETH mint: require balance >= amount + gas reserve so wallet never fails with "Insufficient funds"
  const exceedsBalance = depositToken.symbol === 'ETH' && parsedAmount > 0n && parsedAmount > maxMintEth;
  const exceedsWbtcBalance = isBtc && wbtcBalance && parsedAmount > 0n && parsedAmount > wbtcBalance.value;

  const needsApproval = (depositToken.symbol !== 'ETH' || isBtc) && 
    allowance !== undefined && 
    parsedAmount > BigInt(0) && 
    allowance < parsedAmount;

  const handleApprove = async () => {
    if (!parsedAmount) return;

    approve({
      address: depositToken.address as `0x${string}`,
      abi: kashTokenABI,
      functionName: 'approve',
      args: [kashYield, parsedAmount],
      ...gasOptions,
    });
  };

  const handleMint = async () => {
    if (!parsedAmount || exceedsBalance || exceedsWbtcBalance) return;

    try {
      if (depositToken.symbol === 'ETH' && !isBtc) {
        mint({
          address: kashYield,
          abi: kashYieldABI,
          functionName: 'requestMint',
          args: [BigInt(0)],
          value: parsedAmount,
          ...gasOptions,
        });
      } else {
        mint({
          address: kashYield,
          abi: kashYieldABI,
          functionName: 'requestMint',
          args: [parsedAmount],
          ...gasOptions,
        });
      }
    } catch (error) {
      console.error('Mint error:', error);
    }
  };

  const handleCancelMint = () => {
    if (currentBatchCycle === undefined) return;
    cancelMint({
      address: kashYield,
      abi: kashYieldABI,
      functionName: 'cancelMintRequest',
      args: [currentBatchCycle],
      ...gasOptions,
    });
  };

  if (isMintSuccess && amount && mintHash) {
    const txUrl = chainId === HARDHAT_CHAIN_ID ? '#' : `${ARBITRUM_ONE_BLOCK_EXPLORER}/tx/${mintHash}`;
    return (
      <div className="text-center py-8">
        <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
          <svg className="w-8 h-8 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h3 className="text-lg font-semibold text-gray-900 mb-2">Mint Request Submitted!</h3>
        <p className="text-sm text-gray-600 mb-4">
          Your request will be processed in the next batch cycle (23:50 UTC).
        </p>

        <div className="rounded-xl p-4 mb-6 border border-gray-200 bg-indigo-50 shadow-md text-left space-y-2">
          <p className="text-sm font-medium text-gray-700">Deposit summary</p>
          <p className="text-sm text-gray-600">
            You deposited <span className="font-semibold text-indigo-600">{amount} {depositToken.symbol}</span>
          </p>
          <p className="text-sm text-gray-600">
            Transaction:{' '}
            <a
              href={txUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-indigo-600 hover:text-indigo-700 font-mono text-xs break-all transition-colors"
            >
              {mintHash.slice(0, 10)}…{mintHash.slice(-8)}
            </a>
            <span className="text-gray-500 ml-1">(opens block explorer)</span>
          </p>
        </div>

        <button
          type="button"
          onClick={() => setAmount('')}
          className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors cursor-pointer"
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
        Deposit: {depositToken.symbol}
      </div>

      {/* Amount Input */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="block text-sm font-medium text-gray-700">Amount</label>
          {depositToken.symbol === 'ETH' && !isBtc && address && (
            <span className="text-xs text-gray-500">
              Balance: {formatEtherDisplayDecimals(nativeBalance, 6)} ETH
              {maxMintEth > 0n && (
                <button
                  type="button"
                  onClick={() => setAmount(formatEther(maxMintEth))}
                  className="ml-1.5 text-indigo-600 hover:text-indigo-700 font-medium"
                >
                  Max
                </button>
              )}
            </span>
          )}
          {isBtc && address && wbtcBalance && (
            <span className="text-xs text-gray-500">
              Balance: {Number(formatUnits(wbtcBalance.value, 8)).toFixed(8)} wBTC
              {wbtcBalance.value > 0n && (
                <button
                  type="button"
                  onClick={() => setAmount(formatUnits(wbtcBalance!.value, 8))}
                  className="ml-1.5 text-indigo-600 hover:text-indigo-700 font-medium"
                >
                  Max
                </button>
              )}
            </span>
          )}
        </div>
        <input
          type="number"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0.0"
          className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
        />
      </div>

      {exceedsBalance && (
        <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg">
          <p className="text-sm text-amber-800">
            Amount exceeds available balance. Leave some ETH for gas (we reserve 0.0005 ETH). Use <strong>Max</strong> or reduce the amount.
          </p>
        </div>
      )}

      {exceedsWbtcBalance && (
        <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg">
          <p className="text-sm text-amber-800">
            Amount exceeds your wBTC balance. Use <strong>Max</strong> or reduce the amount.
          </p>
        </div>
      )}


      {/* Settled mint: success message */}
      {mintSettled && !hideSettled && (
        <div className="rounded-lg border border-green-200 bg-green-50 p-3 flex items-start justify-between gap-2">
          <p className="text-sm text-green-800 font-medium">Your mint request for this batch has been settled! KASH tokens have been minted to your wallet.</p>
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

      {/* Pending mint: Cancel button */}
      {canCancelMint && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
          <p className="text-sm text-amber-800 mb-2">You have a pending mint request for this batch cycle.</p>
          <button
            type="button"
            onClick={handleCancelMint}
            disabled={isCancelMintPending || isCancelMintConfirming}
            className="w-full px-4 py-2 bg-amber-600 text-white rounded-lg text-sm font-medium hover:bg-amber-700 disabled:bg-gray-300 disabled:cursor-not-allowed cursor-pointer transition-colors"
          >
            {isCancelMintPending || isCancelMintConfirming ? 'Cancelling...' : 'Cancel Mint Request'}
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
            className="w-full px-6 py-3 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-700 disabled:bg-gray-300 disabled:cursor-not-allowed cursor-pointer transition-colors"
          >
            {isApprovePending || isApproveConfirming ? 'Approving...' : `Approve ${depositToken.symbol}`}
          </button>
        )}
        
        <button
          type="button"
          onClick={handleMint}
          disabled={isMintPending || isMintConfirming || !amount || needsApproval || exceedsBalance || !!exceedsWbtcBalance}
          className="w-full px-6 py-3 bg-linear-to-r from-indigo-600 to-purple-600 text-white rounded-lg font-medium hover:from-indigo-700 hover:to-purple-700 disabled:from-gray-300 disabled:to-gray-400 disabled:cursor-not-allowed cursor-pointer transition-all shadow-lg"
        >
          {isMintPending || isMintConfirming ? 'Processing...' : 'Submit Mint Request'}
        </button>
      </div>

      {/* Error Messages */}
      {(mintError || isMintError) && (
        <div className="p-3 rounded-lg border border-red-200 bg-red-50 text-left">
          {isUserRejectedWalletError(mintError) ? (
            <>
              <p className="text-sm font-medium text-red-800">Mint request cancelled</p>
              <p className="text-xs text-red-600/90 mt-1.5 leading-relaxed">
                You closed the wallet prompt or declined the transaction. No funds were spent. Submit again when you are ready.
              </p>
            </>
          ) : (
            <>
              <p className="text-sm font-medium text-red-800">Transaction failed</p>
              <p className="text-xs text-red-600 mt-1.5 leading-relaxed">
                The mint request could not be completed. Try again, or check your wallet for details.
              </p>
            </>
          )}
        </div>
      )}

      {(approveError || isApproveError) && (
        <div className="p-3 rounded-lg border border-red-200 bg-red-50 text-left">
          {isUserRejectedWalletError(approveError) ? (
            <>
              <p className="text-sm font-medium text-red-800">Approval request cancelled</p>
              <p className="text-xs text-red-600/90 mt-1.5 leading-relaxed">
                You closed the wallet prompt or declined the transaction. No funds were spent. Approve again when you are ready to continue.
              </p>
            </>
          ) : (
            <>
              <p className="text-sm font-medium text-red-800">Approval failed</p>
              <p className="text-xs text-red-600 mt-1.5 leading-relaxed">
                The approval transaction could not be completed. Try again, or check your wallet for details.
              </p>
            </>
          )}
        </div>
      )}

      {/*<p className="text-xs text-gray-500 text-center">
        Fee: 0.03% | Processed at next batch (23:50 UTC)
      </p>*/}
    </div>
  );
}
