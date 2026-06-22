'use client';

import { useState, useMemo, useEffect } from 'react';
import { useWriteContract, useWaitForTransactionReceipt, useAccount, useReadContract, useBalance, useEstimateFeesPerGas, usePublicClient, useReadContracts } from 'wagmi';
import { CONTRACTS, ARBITRUM_ONE_BLOCK_EXPLORER, HARDHAT_CHAIN_ID } from '@/lib/contracts/addresses';
import { ContractVerifiedBadge } from '@/components/ContractVerifiedBadge';
import { BatchUserCapStatus } from '@/components/BatchUserCapStatus';
import { kashYieldABI } from '@/lib/contracts/kashYieldABI';
import { kashTokenABI } from '@/lib/contracts/kashTokenABI';
import { usePendingBatchRequest, type PendingBatchRequest } from '@/lib/usePendingBatchRequest';
import { resolveMintClaimProof, formatMintClaimAmount } from '@/lib/mintProofs';
import { useBatchUserCap } from '@/lib/useBatchUserCap';
import {
  batchCapNotice,
  batchCapSubmitLabel,
  isMintCapReachedError,
} from '@/lib/batchUserCap';
import { chainlinkAggregatorABI } from '@/lib/contracts/chainlinkAggregatorABI';
import { parseEther, parseUnits, formatEther, formatUnits, zeroAddress } from 'viem';
import { useChainId } from 'wagmi';

// Reserve this much native ETH for gas so wallet never sees "Insufficient funds" (deposit + gas > balance)
const GAS_RESERVE_ETH = parseEther('0.0005');

// Arbitrum One fallback when fee estimate is missing (1 gwei). Avoids wallets applying wrong-chain defaults.
const ARB_L2_FALLBACK_MAX_FEE_WEI = 10n ** 9n;

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

/** Minimum mint notional (18-dec USD) — matches bot NET_MINT_SKIP_OPS_MIN_USDC default. */
const MIN_MINT_USD_WEI18 = 10n * 10n ** 18n;

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

function readTupleAnswer(readData: unknown): bigint | undefined {
  if (!readData || !Array.isArray(readData) || readData.length < 2 || readData[1] == null) return undefined;
  try {
    const a = readData[1];
    return typeof a === 'bigint' ? a : BigInt(a as string | number);
  } catch {
    return undefined;
  }
}

/** USD value as 18-decimal fixed point: deposit (smallest units) × oracle USD price. */
function usdWei18FromDepositAndOracle(
  depositSmallestUnits: bigint,
  tokenDecimals: number,
  oracleAnswer: bigint | undefined,
  oracleDecimals: number | undefined,
): bigint | null {
  if (depositSmallestUnits <= 0n || oracleAnswer === undefined || oracleAnswer <= 0n || oracleDecimals === undefined) {
    return null;
  }
  return (depositSmallestUnits * oracleAnswer * 10n ** 18n)
    / (10n ** BigInt(tokenDecimals) * 10n ** BigInt(oracleDecimals));
}

function formatApproxUsd(usdWei18: bigint | null): string {
  if (usdWei18 === null) return '—';
  const n = Number(formatEther(usdWei18));
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function MintForm({ product = 'eth' }: { product?: Product }) {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const chainId = useChainId();
  const blockExplorer = chainId === HARDHAT_CHAIN_ID ? 'http://localhost:8545' : ARBITRUM_ONE_BLOCK_EXPLORER;

  const isBtc = product === 'btc' && CONTRACTS.kashYieldBtc && CONTRACTS.mockWbtc;
  const kashYield = isBtc ? CONTRACTS.kashYieldBtc! : CONTRACTS.kashYieldEth;
  const depositToken = isBtc ? MINT_TOKEN_BTC : MINT_TOKEN_ETH;
  const [amount, setAmount] = useState('');
  const [showMintConfirm, setShowMintConfirm] = useState(false);
  const [submittedMint, setSubmittedMint] = useState<{
    hash: `0x${string}`;
    amount: string;
    product: Product;
    symbol: string;
  } | null>(null);
  const [lastActivityRefreshHash, setLastActivityRefreshHash] = useState<`0x${string}` | null>(null);
  const [claimingCycle, setClaimingCycle] = useState<string | null>(null);
  const [pendingClaimCycle, setPendingClaimCycle] = useState<bigint | null>(null);
  const [claimErrors, setClaimErrors] = useState<Record<string, string>>({});
  const [claimPayouts, setClaimPayouts] = useState<Record<string, bigint | null>>({});

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

  const {
    batchProcessed,
    mintUsersCount,
    batchUserCap,
    mintBlocked,
  } = useBatchUserCap(kashYield);

  const {
    requests: mintRequests,
    cancellable: cancellableMint,
    stuck: stuckMint,
    refetch: refetchPendingLookback,
  } = usePendingBatchRequest({
    kashYield,
    userAddress: address,
    currentBatchCycle,
    kind: 'mint',
  });

  const kashSymbol = isBtc ? 'KASH-BTC' : 'KASH-ETH';

  const spotOracleAddress = isBtc ? CONTRACTS.oracles.btcUsd : CONTRACTS.oracles.ethUsd;

  const { data: oracleRound, isFetched: oracleRoundFetched } = useReadContract({
    address: spotOracleAddress,
    abi: chainlinkAggregatorABI,
    functionName: 'latestRoundData',
    query: { refetchInterval: 60_000 },
  });

  const { data: oracleDecimalsRaw } = useReadContract({
    address: spotOracleAddress,
    abi: chainlinkAggregatorABI,
    functionName: 'decimals',
    query: { refetchInterval: 60_000 },
  });

  const oracleAnswer = readTupleAnswer(oracleRound);
  const oracleDecimals =
    oracleDecimalsRaw !== undefined ? Number(oracleDecimalsRaw as number | bigint) : undefined;

  const { data: cycleDurationSecondsRaw } = useReadContract({
    address: kashYield,
    abi: kashYieldABI,
    functionName: 'cycleDurationSeconds',
  });
  const cycleDuration = cycleDurationSecondsRaw !== undefined ? Number(cycleDurationSecondsRaw) : 86400;
  const isShortCycle = cycleDuration < 86400;

  const { data: currentCycleMintRequest } = useReadContract({
    address: kashYield,
    abi: kashYieldABI,
    functionName: 'getPendingMintRequest',
    args: address && currentBatchCycle !== undefined ? [address, currentBatchCycle] : undefined,
    query: { refetchInterval: 15000 },
  });

  const userInCurrentMintBatch = (currentCycleMintRequest?.amountIn ?? 0n) > 0n;
  const mintBatchCapBlocked = mintBlocked(userInCurrentMintBatch);
  const canCancelMint = Boolean(cancellableMint && cancellableMint.amount > 0n);
  const hasStuckMint = Boolean(stuckMint && stuckMint.amount > 0n);

  const processedMintRequests = useMemo(
    () => mintRequests.filter((r) => r.processed && r.amount > 0n),
    [mintRequests],
  );

  const mintClaimedContracts = useMemo(() => {
    if (!address || processedMintRequests.length === 0) return [];
    return processedMintRequests.map((r) => ({
      address: kashYield,
      abi: kashYieldABI,
      functionName: 'mintClaimed' as const,
      args: [r.batchCycle, address] as const,
    }));
  }, [kashYield, address, processedMintRequests]);

  const { data: mintClaimedResults, refetch: refetchClaimStatuses } = useReadContracts({
    contracts: mintClaimedContracts,
    query: {
      enabled: mintClaimedContracts.length > 0,
      refetchInterval: 15_000,
    },
  });

  const claimableMints = useMemo((): PendingBatchRequest[] => {
    const unclaimed: PendingBatchRequest[] = [];
    for (let i = 0; i < processedMintRequests.length; i++) {
      const req = processedMintRequests[i];
      const claimed =
        mintClaimedResults?.[i]?.status === 'success' &&
        mintClaimedResults[i].result === true;
      if (!claimed) unclaimed.push(req);
    }
    return unclaimed.sort((a, b) => (a.batchCycle > b.batchCycle ? -1 : 1));
  }, [processedMintRequests, mintClaimedResults]);

  const needsClaim = claimableMints.length > 0;

  useEffect(() => {
    if (!address || claimableMints.length === 0) {
      setClaimPayouts({});
      return;
    }
    let cancelled = false;
    setClaimPayouts({});
    const loadPayouts = async () => {
      const entries = await Promise.all(
        claimableMints.map(async (req) => {
          const key = req.batchCycle.toString();
          const proof = await resolveMintClaimProof({
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
  }, [address, claimableMints, product, publicClient, kashYield]);

  const { writeContract: approve, data: approveHash, isPending: isApprovePending, error: approveError } = useWriteContract();
  const mintWriteResult = useWriteContract();
  const { writeContract: mint, data: mintHash, isPending: isMintPending, error: mintError } = mintWriteResult;
  const resetMint = 'reset' in mintWriteResult ? (mintWriteResult as { reset: () => void }).reset : () => {};
  const { writeContract: cancelMint, data: cancelMintHash, isPending: isCancelMintPending } = useWriteContract();
  const claimWrite = useWriteContract();
  const { writeContract: claimMint, data: claimHash, isPending: isClaimPending } = claimWrite;

  const { isLoading: isApproveConfirming, isSuccess: isApproveSuccess, isError: isApproveError } = useWaitForTransactionReceipt({ hash: approveHash });
  const { isLoading: isMintConfirming, isSuccess: isMintSuccess, isError: isMintError } = useWaitForTransactionReceipt({ hash: mintHash });
  const { isLoading: isCancelMintConfirming } = useWaitForTransactionReceipt({ hash: cancelMintHash });
  const { isLoading: isClaimConfirming, isSuccess: isClaimSuccess } = useWaitForTransactionReceipt({ hash: claimHash });

  const handleClaimMint = async (batchCycle: bigint) => {
    if (!address) return;
    const cycleKey = batchCycle.toString();
    setClaimErrors((prev) => {
      const next = { ...prev };
      delete next[cycleKey];
      return next;
    });
    setClaimingCycle(cycleKey);
    try {
      const proofData = await resolveMintClaimProof({
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
      claimMint({
        address: kashYield,
        abi: kashYieldABI,
        functionName: 'claimMint',
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

  // Refetch allowance after approve succeeds so UI updates and Submit Mint Request becomes enabled
  useEffect(() => {
    if (isApproveSuccess && refetchAllowance) {
      refetchAllowance();
    }
  }, [isApproveSuccess, refetchAllowance]);

  // Refetch pending request after mint confirms so cancel button and status update immediately
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
    if (isMintSuccess) {
      refetchPendingLookback();
    }
  }, [isMintSuccess, refetchPendingLookback]);

  useEffect(() => {
    if (isMintSuccess && mintHash && amount && lastActivityRefreshHash !== mintHash) {
      setSubmittedMint({ hash: mintHash, amount, product, symbol: depositToken.symbol });
      setLastActivityRefreshHash(mintHash);
      dispatchActivityRefresh();
    }
  }, [isMintSuccess, mintHash, amount, lastActivityRefreshHash, product, depositToken.symbol]);

  const parsedAmount = amount ?
    (depositToken.symbol === 'ETH' ? parseEther(amount) : parseUnits(amount, depositToken.decimals))
    : BigInt(0);

  const mintApproxUsdWei18 = useMemo(() => {
    try {
      return usdWei18FromDepositAndOracle(
        parsedAmount,
        depositToken.decimals,
        oracleAnswer && oracleAnswer > 0n ? oracleAnswer : undefined,
        oracleDecimals,
      );
    } catch {
      return null;
    }
  }, [parsedAmount, depositToken.decimals, oracleAnswer, oracleDecimals]);

  const mintUsdLabel = formatApproxUsd(mintApproxUsdWei18);

  const mintBelowMinUsd =
    mintApproxUsdWei18 !== null && mintApproxUsdWei18 > 0n && mintApproxUsdWei18 < MIN_MINT_USD_WEI18;
  const mintUsdUnavailable =
    parsedAmount > 0n && mintApproxUsdWei18 === null && oracleRoundFetched;

  useEffect(() => {
    if (!showMintConfirm) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowMintConfirm(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showMintConfirm]);

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
    if (!parsedAmount || exceedsBalance || exceedsWbtcBalance || mintBelowMinUsd || mintUsdUnavailable) return;
    setShowMintConfirm(false);

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
    if (!cancellableMint) return;
    cancelMint({
      address: kashYield,
      abi: kashYieldABI,
      functionName: 'cancelMintRequest',
      args: [cancellableMint.batchCycle],
      ...gasOptions,
    });
  };

  if (submittedMint && submittedMint.product === product && !needsClaim) {
    const txUrl = chainId === HARDHAT_CHAIN_ID ? '#' : `${ARBITRUM_ONE_BLOCK_EXPLORER}/tx/${submittedMint.hash}`;
    return (
      <div className="text-center py-8">
        <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
          <svg className="w-8 h-8 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h3 className="text-lg font-semibold text-gray-900 mb-2">Mint Request Submitted!</h3>
        <p className="text-sm text-gray-600 mb-4">
          Your request will be processed in the next batch cycle (23:40 UTC). After settlement, return here and use{' '}
          <span className="font-medium">Claim {kashSymbol}</span> to receive your KASH tokens.
        </p>

        <div className="rounded-xl p-4 mb-6 border border-gray-200 bg-indigo-50 shadow-md text-left space-y-2">
          <p className="text-sm font-medium text-gray-700">Deposit summary</p>
          <p className="text-sm text-gray-600">
            You deposited <span className="font-semibold text-indigo-600">{submittedMint.amount} {submittedMint.symbol}</span>
          </p>
          <p className="text-sm text-gray-600">
            Transaction:{' '}
            <a
              href={txUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-indigo-600 hover:text-indigo-700 font-mono text-xs break-all transition-colors"
            >
              {submittedMint.hash.slice(0, 10)}…{submittedMint.hash.slice(-8)}
            </a>
            <span className="text-gray-500 ml-1">(opens block explorer)</span>
          </p>
        </div>

        <button
          type="button"
          onClick={() => {
            setSubmittedMint(null);
            setAmount('');
            setShowMintConfirm(false);
            resetMint();
          }}
          className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors cursor-pointer"
        >
          Make Another Request
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4 relative">
      {showMintConfirm && (
        <div
          className="fixed inset-0 z-110 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="mint-confirm-title"
        >
          <button
            type="button"
            className="absolute inset-0 cursor-pointer backdrop-blur-sm"
            style={{ backgroundColor: 'rgba(10, 10, 30, 0.82)' }}
            aria-label="Dismiss"
            onClick={() => setShowMintConfirm(false)}
          />
          <div
            className="relative z-111 bg-white rounded-2xl shadow-xl border max-w-md w-full p-6 text-left"
            style={{ borderColor: 'rgba(0, 255, 255, 0.22)', boxShadow: '0 10px 40px rgba(0, 0, 0, 0.45), 0 0 25px rgba(0, 255, 255, 0.08)' }}
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="w-9 h-9 bg-green-100 rounded-lg flex items-center justify-center shrink-0 border border-transparent" style={{ boxShadow: '0 0 12px rgba(0, 255, 255, 0.12)' }}>
                <svg className="w-5 h-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
              </div>
              <h3 id="mint-confirm-title" className="text-xl font-bold text-gray-900">
                Confirm mint
              </h3>
            </div>
            <p className="text-sm text-gray-600 leading-relaxed">
              You are swapping{' '}
              <span className="font-semibold text-gray-900">
                {amount} {depositToken.symbol}
              </span>{' '}
              currently valued at approximately{' '}
              <span className="font-semibold text-indigo-600">${mintUsdLabel}</span>
              {!oracleRoundFetched && mintApproxUsdWei18 === null && parsedAmount > 0n ? (
                <span className="text-gray-500"> (loading price…)</span>
              ) : null}
            </p>
            <p className="text-xs text-gray-500 mt-4 leading-relaxed">
              and will receive KASH tokens at an NAV determined at the end of the next batch cycle.
              After the batch settles, use the <span className="font-medium">Claim {kashSymbol}</span> button on this form to receive your tokens (Merkle pull claim).
            </p>
            <div className="flex flex-col sm:flex-row gap-3 mt-6">
              <button
                type="button"
                onClick={() => setShowMintConfirm(false)}
                className="flex-1 px-6 py-3 rounded-lg font-medium transition border cursor-pointer bg-white/10 text-gray-400 hover:text-white border-white/20 hover:bg-white/15"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleMint()}
                disabled={isMintPending || isMintConfirming || mintBelowMinUsd || mintUsdUnavailable || mintBatchCapBlocked}
                className="flex-1 px-6 py-3 rounded-lg bg-linear-to-r from-indigo-600 to-purple-600 text-white font-medium hover:from-indigo-700 hover:to-purple-700 disabled:from-gray-300 disabled:to-gray-400 disabled:cursor-not-allowed cursor-pointer transition-all shadow-lg disabled:shadow-none border-2 border-transparent"
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
      <BatchUserCapStatus
        kind="mint"
        usersCount={mintUsersCount}
        cap={batchUserCap}
        batchProcessed={batchProcessed}
        userAlreadyInBatch={userInCurrentMintBatch}
      />
      {/* Token (single option per product) */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-medium text-gray-700">
          Deposit: {depositToken.symbol}
        </div>
        <ContractVerifiedBadge contractAddress={kashYield} />
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

      {mintBelowMinUsd && (
        <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg">
          <p className="text-sm text-amber-800">
            Minimum mint is <strong>$10.00</strong> (approx. ${mintUsdLabel}). Increase the amount to submit a mint request.
          </p>
        </div>
      )}

      {mintUsdUnavailable && (
        <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg">
          <p className="text-sm text-amber-800">
            USD value unavailable — wait for the price feed to load before submitting.
          </p>
        </div>
      )}


      {needsClaim && (
        <div className="rounded-lg border border-green-200 bg-green-50 p-3 space-y-3">
          <p className="text-sm text-green-800 font-medium">
            {claimableMints.length === 1
              ? `Your mint for batch cycle ${claimableMints[0].batchCycle.toString()} is settled.`
              : `You have ${claimableMints.length} settled mints ready to claim.`}
          </p>
          <ul className="space-y-2">
            {claimableMints.map((req) => {
              const cycleKey = req.batchCycle.toString();
              const payout = claimPayouts[cycleKey];
              const claimErr = claimErrors[cycleKey];
              const isThisClaimPending =
                claimingCycle === cycleKey &&
                (isClaimPending || isClaimConfirming || pendingClaimCycle === req.batchCycle);
              return (
                <li
                  key={cycleKey}
                  className="kash-notice-nested rounded-md border border-green-200 p-3 space-y-2"
                >
                  <p className="text-sm text-gray-700">
                    <span className="font-medium text-green-800">Batch {cycleKey}</span>
                    {payout != null ? (
                      <>
                        {' · '}
                        Claim <span className="font-medium">{formatMintClaimAmount(payout)}</span> {kashSymbol}
                      </>
                    ) : (
                      <> · Loading claim amount…</>
                    )}
                  </p>
                  {claimErr ? <p className="text-sm text-red-600">{claimErr}</p> : null}
                  <button
                    type="button"
                    onClick={() => void handleClaimMint(req.batchCycle)}
                    disabled={isThisClaimPending || payout == null}
                    className="w-full px-4 py-2 bg-green-700 text-white rounded-lg text-sm font-medium hover:bg-green-800 disabled:bg-gray-300 disabled:cursor-not-allowed cursor-pointer transition-colors"
                  >
                    {isThisClaimPending ? 'Claiming…' : `Claim ${kashSymbol}`}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Pending mint: Cancel button */}
      {canCancelMint && cancellableMint && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
          <p className="text-sm text-amber-800 mb-2">
            You have a pending mint request for batch cycle {cancellableMint.batchCycle.toString()}.
          </p>
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

      {hasStuckMint && stuckMint && !canCancelMint && (
        <div className="rounded-lg border border-orange-200 bg-orange-50 p-3">
          <p className="text-sm text-orange-900 font-medium mb-1">Mint in progress (batch cycle {stuckMint.batchCycle.toString()})</p>
          <p className="text-sm text-orange-800">
            Your deposit is locked while the batch completes (phase {stuckMint.phase}). Cancellation is not available once processing has started.
          </p>
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
          onClick={() => setShowMintConfirm(true)}
          disabled={
            isMintPending ||
            isMintConfirming ||
            !amount ||
            needsApproval ||
            exceedsBalance ||
            !!exceedsWbtcBalance ||
            mintBelowMinUsd ||
            mintUsdUnavailable ||
            mintBatchCapBlocked
          }
          className="w-full px-6 py-3 bg-linear-to-r from-indigo-600 to-purple-600 text-white rounded-lg font-medium hover:from-indigo-700 hover:to-purple-700 disabled:from-gray-300 disabled:to-gray-400 disabled:cursor-not-allowed cursor-pointer transition-all shadow-lg"
        >
          {isMintPending || isMintConfirming
            ? 'Processing...'
            : batchCapSubmitLabel('mint', mintBatchCapBlocked)}
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
          ) : isMintCapReachedError(mintError) ? (
            <>
              <p className="text-sm font-medium text-red-800">Mint batch full</p>
              <p className="text-xs text-red-600 mt-1.5 leading-relaxed">
                {batchCapNotice('mint')}
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
        Fee: 0.05% | Processed at next batch (23:40 UTC)
      </p>*/}
    </div>
  );
}
