'use client';

import { useState, useMemo } from 'react';
import { useWriteContract, useWaitForTransactionReceipt, useAccount, useReadContract, useBalance, useEstimateFeesPerGas } from 'wagmi';
import { CONTRACTS, ARBITRUM_SEPOLIA_BLOCK_EXPLORER } from '@/lib/contracts/addresses';
import { kashYieldABI } from '@/lib/contracts/kashYieldABI';
import { kashTokenABI } from '@/lib/contracts/kashTokenABI';
import { parseEther, parseUnits, formatEther, zeroAddress } from 'viem';

// Reserve this much native ETH for gas so wallet never sees "Insufficient funds" (deposit + gas > balance)
const GAS_RESERVE_ETH = parseEther('0.0005');

// Arbitrum Sepolia fallback: 1 gwei. Without explicit gas, wallet can fall back to mainnet defaults → insane "$15M" fee.
const ARB_SEPOLIA_MAX_FEE_WEI = 10n ** 9n; // 1 gwei

// ETH product: single "ETH" option (native ETH; protocol wraps to wETH for Aave). wBTC shown but disabled until KashYieldBTC.
const MINT_TOKENS_ETH = [
  { symbol: 'ETH', address: zeroAddress, decimals: 18, disabled: false },
  { symbol: 'wBTC', address: CONTRACTS.tokens.wbtc, decimals: 8, disabled: true },
];
const TOKENS = MINT_TOKENS_ETH;

export function MintForm() {
  const { address } = useAccount();
  const [selectedToken, setSelectedToken] = useState(MINT_TOKENS_ETH[0]!);
  const [amount, setAmount] = useState('');

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
      maxFeePerGas: ARB_SEPOLIA_MAX_FEE_WEI,
      maxPriorityFeePerGas: ARB_SEPOLIA_MAX_FEE_WEI,
    };
  }, [feesPerGas?.maxFeePerGas, feesPerGas?.maxPriorityFeePerGas]);

  const { data: allowance } = useReadContract({
    address: selectedToken.address as `0x${string}`,
    abi: kashTokenABI,
    functionName: 'allowance',
    args: address && selectedToken.symbol !== 'ETH' ? [address, CONTRACTS.kashYieldEth] : undefined,
  });

  const { data: currentBatchCycle } = useReadContract({
    address: CONTRACTS.kashYieldEth,
    abi: kashYieldABI,
    functionName: 'getCurrentBatchCycle',
  });

  const { data: batchInfo } = useReadContract({
    address: CONTRACTS.kashYieldEth,
    abi: kashYieldABI,
    functionName: 'getBatchInfo',
    args: currentBatchCycle !== undefined ? [currentBatchCycle] : undefined,
  });

  const { data: pendingMintRequest } = useReadContract({
    address: CONTRACTS.kashYieldEth,
    abi: kashYieldABI,
    functionName: 'getPendingMintRequest',
    args: address && currentBatchCycle !== undefined ? [address, currentBatchCycle] : undefined,
  });

  const batchProcessed = batchInfo ? (batchInfo as readonly [bigint, bigint, boolean, bigint, bigint])[2] : true;
  const canCancelMint = Boolean(
    address &&
    currentBatchCycle !== undefined &&
    batchInfo &&
    !batchProcessed &&
    pendingMintRequest &&
    pendingMintRequest.amountIn > 0n
  );

  const { writeContract: approve, data: approveHash, isPending: isApprovePending, error: approveError } = useWriteContract();
  const { writeContract: mint, data: mintHash, isPending: isMintPending, error: mintError } = useWriteContract();
  const { writeContract: cancelMint, data: cancelMintHash, isPending: isCancelMintPending } = useWriteContract();

  const { isLoading: isApproveConfirming, isError: isApproveError } = useWaitForTransactionReceipt({ hash: approveHash });
  const { isLoading: isMintConfirming, isSuccess: isMintSuccess, isError: isMintError } = useWaitForTransactionReceipt({ hash: mintHash });
  const { isLoading: isCancelMintConfirming } = useWaitForTransactionReceipt({ hash: cancelMintHash });

  // Helper to safely render error cause
  const renderErrorCause = (error: typeof mintError) => {
    if (!error?.cause) return null;
    const cause = error.cause;
    if (cause instanceof Error) return cause.message;
    if (typeof cause === 'string') return cause;
    return 'Unknown error';
  };

  const parsedAmount = amount ?
    (selectedToken.symbol === 'ETH' ? parseEther(amount) : parseUnits(amount, selectedToken.decimals))
    : BigInt(0);

  // For ETH mint: require balance >= amount + gas reserve so wallet never fails with "Insufficient funds"
  const exceedsBalance = selectedToken.symbol === 'ETH' && parsedAmount > 0n && parsedAmount > maxMintEth;

  const needsApproval = selectedToken.symbol !== 'ETH' && 
    allowance !== undefined && 
    parsedAmount > BigInt(0) && 
    allowance < parsedAmount;

  const handleApprove = async () => {
    if (!parsedAmount) return;

    approve({
      address: selectedToken.address as `0x${string}`,
      abi: kashTokenABI,
      functionName: 'approve',
      args: [CONTRACTS.kashYieldEth, parsedAmount],
      ...gasOptions,
    });
  };

  const handleMint = async () => {
    if (!parsedAmount || exceedsBalance) return;

    try {
      if (selectedToken.symbol === 'ETH') {
        mint({
          address: CONTRACTS.kashYieldEth,
          abi: kashYieldABI,
          functionName: 'requestMint',
          args: [BigInt(0)],
          value: parsedAmount,
          ...gasOptions,
        });
      } else {
        mint({
          address: CONTRACTS.kashYieldEth,
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
      address: CONTRACTS.kashYieldEth,
      abi: kashYieldABI,
      functionName: 'cancelMintRequest',
      args: [currentBatchCycle],
      ...gasOptions,
    });
  };

  if (isMintSuccess && amount && mintHash) {
    const txUrl = `${ARBITRUM_SEPOLIA_BLOCK_EXPLORER}/tx/${mintHash}`;
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
            You deposited <span className="font-semibold text-indigo-600">{amount} {selectedToken.symbol}</span>
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
      {/* Token Selector */}
      <div>
        {/*<label className="block text-sm font-medium text-gray-700 mb-2">Select Token (ETH product → KASH_ETH)</label>*/}
        <div className="grid grid-cols-2 gap-2">
          {MINT_TOKENS_ETH.map((token) => {
            const isDisabled = 'disabled' in token && token.disabled;
            return (
              <button
                key={token.symbol}
                type="button"
                onClick={() => !isDisabled && setSelectedToken(token)}
                disabled={isDisabled}
                className={`px-4 py-2 rounded-lg border-2 transition-all ${
                  isDisabled
                    ? 'border-gray-200 bg-gray-200/60 text-gray-500 cursor-default'
                    : selectedToken.symbol === token.symbol
                      ? 'border-indigo-600 bg-indigo-50 text-indigo-700 cursor-pointer'
                      : 'border-gray-200 hover:border-gray-300 text-gray-700 cursor-pointer'
                }`}
              >
                {token.symbol}
              </button>
            );
          })}
        </div>
        {/*<p className="text-xs text-gray-500 mt-1.5">
          Deposit native ETH (no approval). The protocol wraps ETH to wETH when supplying to Aave. wBTC (KASH_BTC) coming soon.
        </p>*/}
      </div>

      {/* Amount Input */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="block text-sm font-medium text-gray-700">Amount</label>
          {selectedToken.symbol === 'ETH' && address && (
            <span className="text-xs text-gray-500">
              Balance: {formatEther(nativeBalance)} ETH
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
            {isApprovePending || isApproveConfirming ? 'Approving...' : `Approve ${selectedToken.symbol}`}
          </button>
        )}
        
        <button
          type="button"
          onClick={handleMint}
          disabled={isMintPending || isMintConfirming || !amount || needsApproval || exceedsBalance}
          className="w-full px-6 py-3 bg-linear-to-r from-indigo-600 to-purple-600 text-white rounded-lg font-medium hover:from-indigo-700 hover:to-purple-700 disabled:from-gray-300 disabled:to-gray-400 disabled:cursor-not-allowed cursor-pointer transition-all shadow-lg"
        >
          {isMintPending || isMintConfirming ? 'Processing...' : 'Submit Mint Request'}
        </button>
      </div>

      {/* Error Messages */}
      {(mintError || isMintError) && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-sm text-red-800 font-medium">Transaction Failed</p>
          <p className="text-xs text-red-600 mt-1">
            {mintError?.message || 'Transaction was rejected or failed. Please try again.'}
          </p>
          {mintError?.cause !== undefined && mintError.cause !== null && (
            <p className="text-xs text-red-500 mt-1">
              {renderErrorCause(mintError)}
            </p>
          )}
        </div>
      )}

      {(approveError || isApproveError) && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-sm text-red-800 font-medium">Approval Failed</p>
          <p className="text-xs text-red-600 mt-1">
            {approveError?.message || 'Approval transaction failed. Please try again.'}
          </p>
        </div>
      )}

      {/*<p className="text-xs text-gray-500 text-center">
        Fee: 0.03% | Processed at next batch (23:50 UTC)
      </p>*/}
    </div>
  );
}
