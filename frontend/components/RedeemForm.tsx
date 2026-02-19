'use client';

import { useState } from 'react';
import { useWriteContract, useWaitForTransactionReceipt, useAccount, useReadContract } from 'wagmi';
import { CONTRACTS } from '@/lib/contracts/addresses';
import { kashYieldABI } from '@/lib/contracts/kashYieldABI';
import { kashTokenABI } from '@/lib/contracts/kashTokenABI';
import { parseEther, formatEther, zeroAddress } from 'viem';

const TOKENS = [
  { symbol: 'ETH', address: zeroAddress },
  { symbol: 'wETH', address: CONTRACTS.tokens.weth },
  { symbol: 'wBTC', address: CONTRACTS.tokens.wbtc },
];

export function RedeemForm() {
  const { address } = useAccount();
  const [selectedToken, setSelectedToken] = useState(TOKENS[0]);
  const [amount, setAmount] = useState('');

  const { data: kashBalance } = useReadContract({
    address: CONTRACTS.kashToken,
    abi: kashTokenABI,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
  });

  const { data: allowance } = useReadContract({
    address: CONTRACTS.kashToken,
    abi: kashTokenABI,
    functionName: 'allowance',
    args: address ? [address, CONTRACTS.kashYield] : undefined,
  });

  const { writeContract: approve, data: approveHash, isPending: isApprovePending } = useWriteContract();
  const { writeContract: redeem, data: redeemHash, isPending: isRedeemPending } = useWriteContract();

  const { isLoading: isApproveConfirming } = useWaitForTransactionReceipt({ hash: approveHash });
  const { isLoading: isRedeemConfirming, isSuccess: isRedeemSuccess } = useWaitForTransactionReceipt({ hash: redeemHash });

  const parsedAmount = amount ? parseEther(amount) : BigInt(0);
  const needsApproval = allowance !== undefined && parsedAmount > BigInt(0) && allowance < parsedAmount;

  const handleApprove = async () => {
    if (!parsedAmount) return;
    
    approve({
      address: CONTRACTS.kashToken,
      abi: kashTokenABI,
      functionName: 'approve',
      args: [CONTRACTS.kashYield, parsedAmount],
    });
  };

  const handleRedeem = async () => {
    if (!parsedAmount) return;

    redeem({
      address: CONTRACTS.kashYield,
      abi: kashYieldABI,
      functionName: 'requestRedeem',
      args: [parsedAmount, selectedToken.address as `0x${string}`],
    });
  };

  const handleMaxClick = () => {
    if (kashBalance) {
      setAmount(formatEther(kashBalance));
    }
  };

  if (isRedeemSuccess) {
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
        <button
          onClick={() => {
            setAmount('');
          }}
          className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors"
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
        <label className="block text-sm font-medium text-gray-700 mb-2">Receive Token</label>
        <div className="grid grid-cols-3 gap-2">
          {TOKENS.map((token) => (
            <button
              key={token.symbol}
              onClick={() => setSelectedToken(token)}
              className={`px-4 py-2 rounded-lg border-2 transition-all ${
                selectedToken.symbol === token.symbol
                  ? 'border-purple-600 bg-purple-50 text-purple-700'
                  : 'border-gray-200 hover:border-gray-300 text-gray-700'
              }`}
            >
              {token.symbol}
            </button>
          ))}
        </div>
      </div>

      {/* Amount Input */}
      <div>
        <div className="flex justify-between items-center mb-2">
          <label className="block text-sm font-medium text-gray-700">KASH Amount</label>
          <button
            onClick={handleMaxClick}
            className="text-xs text-purple-600 hover:text-purple-700 font-medium"
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
      </div>

      {/* Action Buttons */}
      <div className="space-y-2">
        {needsApproval && (
          <button
            onClick={handleApprove}
            disabled={isApprovePending || isApproveConfirming || !amount}
            className="w-full px-6 py-3 bg-purple-600 text-white rounded-lg font-medium hover:bg-purple-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
          >
            {isApprovePending || isApproveConfirming ? 'Approving...' : 'Approve KASH'}
          </button>
        )}
        
        <button
          onClick={handleRedeem}
          disabled={isRedeemPending || isRedeemConfirming || !amount || needsApproval || (kashBalance !== undefined && parsedAmount > kashBalance)}
          className="w-full px-6 py-3 bg-gradient-to-r from-purple-600 to-pink-600 text-white rounded-lg font-medium hover:from-purple-700 hover:to-pink-700 disabled:from-gray-300 disabled:to-gray-400 disabled:cursor-not-allowed transition-all shadow-lg"
        >
          {isRedeemPending || isRedeemConfirming ? 'Processing...' : 'Submit Redeem Request'}
        </button>
      </div>

      <p className="text-xs text-gray-500 text-center">
        Fee: 0.03% | Processed at next batch (23:50 UTC)
      </p>
    </div>
  );
}
