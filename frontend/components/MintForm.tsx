'use client';

import { useState, useMemo } from 'react';
import { useWriteContract, useWaitForTransactionReceipt, useAccount, useReadContract, useEstimateFeesPerGas } from 'wagmi';
import { CONTRACTS, ARBITRUM_SEPOLIA_BLOCK_EXPLORER } from '@/lib/contracts/addresses';
import { kashYieldABI } from '@/lib/contracts/kashYieldABI';
import { kashTokenABI } from '@/lib/contracts/kashTokenABI';
import { parseEther, parseUnits, zeroAddress } from 'viem';

// Minimum and buffer so maxFeePerGas is always above block base fee (avoids "max fee per gas less than block base fee")
const MIN_MAX_FEE_GWEI = 30n;
const GWEI = 10n ** 9n;
const FEE_BUFFER_PERCENT = 120n; // 20% buffer over estimated

// ETH product only until KashYieldBTC is deployed; then add wBTC to this list.
const MINT_TOKENS_ETH = [
  { symbol: 'ETH', address: zeroAddress, decimals: 18 },
  { symbol: 'wETH', address: CONTRACTS.tokens.weth, decimals: 18 },
];
const TOKENS = MINT_TOKENS_ETH;

export function MintForm() {
  const { address } = useAccount();
  const [selectedToken, setSelectedToken] = useState(MINT_TOKENS_ETH[0]);
  const [amount, setAmount] = useState('');

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

  const { data: allowance } = useReadContract({
    address: selectedToken.address as `0x${string}`,
    abi: kashTokenABI,
    functionName: 'allowance',
    args: address && selectedToken.symbol !== 'ETH' ? [address, CONTRACTS.kashYieldEth] : undefined,
  });

  const { writeContract: approve, data: approveHash, isPending: isApprovePending, error: approveError } = useWriteContract();
  const { writeContract: mint, data: mintHash, isPending: isMintPending, error: mintError } = useWriteContract();

  const { isLoading: isApproveConfirming, isError: isApproveError } = useWaitForTransactionReceipt({ hash: approveHash });
  const { isLoading: isMintConfirming, isSuccess: isMintSuccess, isError: isMintError } = useWaitForTransactionReceipt({ hash: mintHash });

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
    if (!parsedAmount) return;

    try {
      if (selectedToken.symbol === 'ETH') {
        mint({
          address: CONTRACTS.kashYieldEth,
          abi: kashYieldABI,
          functionName: 'requestMint',
          args: [zeroAddress, BigInt(0)],
          value: parsedAmount,
          ...gasOptions,
        });
      } else {
        mint({
          address: CONTRACTS.kashYieldEth,
          abi: kashYieldABI,
          functionName: 'requestMint',
          args: [selectedToken.address as `0x${string}`, parsedAmount],
          ...gasOptions,
        });
      }
    } catch (error) {
      console.error('Mint error:', error);
    }
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
          onClick={() => setAmount('')}
          className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors"
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
        <label className="block text-sm font-medium text-gray-700 mb-2">Select Token (ETH product → KASH_ETH)</label>
        <div className="grid grid-cols-2 gap-2">
          {MINT_TOKENS_ETH.map((token) => (
            <button
              key={token.symbol}
              onClick={() => setSelectedToken(token)}
              className={`px-4 py-2 rounded-lg border-2 transition-all ${
                selectedToken.symbol === token.symbol
                  ? 'border-indigo-600 bg-indigo-50 text-indigo-700'
                  : 'border-gray-200 hover:border-gray-300 text-gray-700'
              }`}
            >
              {token.symbol}
            </button>
          ))}
        </div>
        <p className="text-xs text-gray-500 mt-1.5">wBTC (KASH_BTC) coming soon when BTC product is deployed.</p>
      </div>

      {/* Amount Input */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">Amount</label>
        <input
          type="number"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0.0"
          className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
        />
      </div>

      {/* Action Buttons */}
      <div className="space-y-2">
        {needsApproval && (
          <button
            onClick={handleApprove}
            disabled={isApprovePending || isApproveConfirming || !amount}
            className="w-full px-6 py-3 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
          >
            {isApprovePending || isApproveConfirming ? 'Approving...' : `Approve ${selectedToken.symbol}`}
          </button>
        )}
        
        <button
          onClick={handleMint}
          disabled={isMintPending || isMintConfirming || !amount || needsApproval}
          className="w-full px-6 py-3 bg-linear-to-r from-indigo-600 to-purple-600 text-white rounded-lg font-medium hover:from-indigo-700 hover:to-purple-700 disabled:from-gray-300 disabled:to-gray-400 disabled:cursor-not-allowed transition-all shadow-lg"
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

      <p className="text-xs text-gray-500 text-center">
        Fee: 0.03% | Processed at next batch (23:50 UTC)
      </p>
    </div>
  );
}
