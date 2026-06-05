'use client';

import { useMemo } from 'react';
import { useReadContracts } from 'wagmi';
import { kashYieldABI } from '@/lib/contracts/kashYieldABI';

/** How many past batch cycles to scan for uncleared mint/redeem requests. */
export const PENDING_REQUEST_LOOKBACK = 20;

export type PendingBatchRequest = {
  batchCycle: bigint;
  amount: bigint;
  phase: number;
  processed: boolean;
  canCancel: boolean;
  isStuck: boolean;
};

type RequestKind = 'mint' | 'redeem';

type BatchInfoResult = readonly [bigint, bigint, boolean, bigint, bigint, bigint];
type MintPending = { amountIn?: bigint };
type RedeemPending = { kashAmount?: bigint };

function cyclesForLookback(currentBatchCycle: bigint | undefined, lookback: number): bigint[] {
  if (currentBatchCycle === undefined) return [];
  const current = Number(currentBatchCycle);
  const out: bigint[] = [];
  for (let i = 0; i < lookback; i++) {
    const c = current - i;
    if (c < 0) break;
    out.push(BigInt(c));
  }
  return out;
}

/**
 * Scans recent batch cycles for an uncleared mint or redeem request.
 * Cancel is only allowed when batchPhase === 0 and the batch is not processed.
 */
export function usePendingBatchRequest(options: {
  kashYield: `0x${string}` | undefined;
  userAddress: `0x${string}` | undefined;
  currentBatchCycle: bigint | undefined;
  kind: RequestKind;
  lookback?: number;
  enabled?: boolean;
}) {
  const {
    kashYield,
    userAddress,
    currentBatchCycle,
    kind,
    lookback = PENDING_REQUEST_LOOKBACK,
    enabled = true,
  } = options;

  const cycles = useMemo(
    () => cyclesForLookback(currentBatchCycle, lookback),
    [currentBatchCycle, lookback],
  );

  const contracts = useMemo(() => {
    if (!kashYield || !userAddress || cycles.length === 0) return [];
    const pendingFn = kind === 'mint' ? 'getPendingMintRequest' as const : 'getPendingRedeemRequest' as const;
    return cycles.flatMap((cycle) => [
      { address: kashYield, abi: kashYieldABI, functionName: 'getBatchInfo' as const, args: [cycle] as const },
      { address: kashYield, abi: kashYieldABI, functionName: 'batchPhase' as const, args: [cycle] as const },
      {
        address: kashYield,
        abi: kashYieldABI,
        functionName: pendingFn,
        args: [userAddress, cycle] as const,
      },
    ]);
  }, [kashYield, userAddress, cycles, kind]);

  const { data: readResults, refetch, isFetching } = useReadContracts({
    contracts,
    query: { enabled: enabled && contracts.length > 0, refetchInterval: 15_000 },
  });

  const requests = useMemo((): PendingBatchRequest[] => {
    if (!readResults || cycles.length === 0) return [];

    const found: PendingBatchRequest[] = [];
    for (let i = 0; i < cycles.length; i++) {
      const base = i * 3;
      const batchR = readResults[base];
      const phaseR = readResults[base + 1];
      const pendingR = readResults[base + 2];

      const processed =
        batchR?.status === 'success' && batchR.result
          ? (batchR.result as BatchInfoResult)[2]
          : false;
      const phase =
        phaseR?.status === 'success' && phaseR.result !== undefined
          ? Number(phaseR.result)
          : 0;

      let amount = 0n;
      if (pendingR?.status === 'success' && pendingR.result) {
        amount =
          kind === 'mint'
            ? (pendingR.result as MintPending).amountIn ?? 0n
            : (pendingR.result as RedeemPending).kashAmount ?? 0n;
      }
      if (amount <= 0n) continue;

      const canCancel = !processed && phase === 0;
      const isStuck = !processed && phase > 0;
      found.push({
        batchCycle: cycles[i],
        amount,
        phase,
        processed,
        canCancel,
        isStuck,
      });
    }
    return found;
  }, [readResults, cycles, kind]);

  const cancellable = requests.find((r) => r.canCancel) ?? null;
  const stuck = requests.find((r) => r.isStuck) ?? null;

  return {
    requests,
    cancellable,
    stuck,
    refetch,
    isFetching,
  };
}
