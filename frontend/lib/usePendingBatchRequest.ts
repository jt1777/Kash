'use client';

import { useMemo } from 'react';
import { useReadContract, useReadContracts } from 'wagmi';
import { vaultAbi, type VaultProduct } from '@/lib/contracts/vaultAbi';

/** Mirrors KashVault CLAIM_EXPIRY_SECONDS (30 days). */
export const CLAIM_EXPIRY_SECONDS = 30 * 86400;

/** Fallback when cycleDurationSeconds has not loaded yet (legacy daily batches). */
export const PENDING_REQUEST_LOOKBACK = 30;

/** Batch cycles to scan so unclaimed mint/redeem stays visible for the full on-chain claim window. */
export function pendingRequestLookbackCycles(cycleDurationSeconds: number | undefined): number {
  const duration = Math.max(60, cycleDurationSeconds ?? 86400);
  return Math.ceil(CLAIM_EXPIRY_SECONDS / duration);
}

export type PendingBatchRequest = {
  batchCycle: bigint;
  amount: bigint;
  claimableAmount: bigint;
  phase: number;
  processed: boolean;
  canCancel: boolean;
  isStuck: boolean;
  claimOpenAt: bigint;
};

type RequestKind = 'mint' | 'redeem';

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

function asUint(result: unknown): bigint {
  if (result === undefined || result === null) return 0n;
  return typeof result === 'bigint' ? result : BigInt(result as string | number);
}

/**
 * Scans recent batch cycles for an uncleared deposit or redeem request.
 * Cancel is only allowed when batchPhase === 0 and the batch is not processed.
 */
export function usePendingBatchRequest(options: {
  kashYield: `0x${string}` | undefined;
  userAddress: `0x${string}` | undefined;
  currentBatchCycle: bigint | undefined;
  kind: RequestKind;
  product: VaultProduct;
  lookback?: number;
  enabled?: boolean;
}) {
  const {
    kashYield,
    userAddress,
    currentBatchCycle,
    kind,
    product,
    lookback: lookbackOverride,
    enabled = true,
  } = options;

  const abi = vaultAbi(product);

  const { data: cycleDurationSecondsRaw } = useReadContract({
    address: kashYield,
    abi,
    functionName: 'cycleDurationSeconds',
    query: { enabled: enabled && !!kashYield },
  });

  const lookback = useMemo(() => {
    if (lookbackOverride !== undefined) return lookbackOverride;
    const duration =
      cycleDurationSecondsRaw !== undefined ? Number(cycleDurationSecondsRaw) : undefined;
    return pendingRequestLookbackCycles(duration);
  }, [lookbackOverride, cycleDurationSecondsRaw]);

  const cycles = useMemo(
    () => cyclesForLookback(currentBatchCycle, lookback),
    [currentBatchCycle, lookback],
  );

  const contracts = useMemo(() => {
    if (!kashYield || !userAddress || cycles.length === 0) return [];
    const pendingFn = kind === 'mint' ? 'pendingDepositRequest' as const : 'pendingRedeemRequest' as const;
    const claimableFn = kind === 'mint' ? 'claimableDepositRequest' as const : 'claimableRedeemRequest' as const;
    return cycles.flatMap((cycle) => [
      { address: kashYield, abi, functionName: 'batchProcessed' as const, args: [cycle] as const },
      { address: kashYield, abi, functionName: 'batchPhase' as const, args: [cycle] as const },
      {
        address: kashYield,
        abi,
        functionName: pendingFn,
        args: [cycle, userAddress] as const,
      },
      {
        address: kashYield,
        abi,
        functionName: claimableFn,
        args: [cycle, userAddress] as const,
      },
      { address: kashYield, abi, functionName: 'claimOpenAt' as const, args: [cycle] as const },
    ]);
  }, [kashYield, userAddress, cycles, kind, abi]);

  const { data: readResults, refetch, isFetching } = useReadContracts({
    contracts,
    query: { enabled: enabled && contracts.length > 0, refetchInterval: 15_000 },
  });

  const requests = useMemo((): PendingBatchRequest[] => {
    if (!readResults || cycles.length === 0) return [];

    const found: PendingBatchRequest[] = [];
    for (let i = 0; i < cycles.length; i++) {
      const base = i * 5;
      const processedR = readResults[base];
      const phaseR = readResults[base + 1];
      const pendingR = readResults[base + 2];
      const claimableR = readResults[base + 3];
      const openR = readResults[base + 4];

      const processed =
        processedR?.status === 'success' ? Boolean(processedR.result) : false;
      const phase =
        phaseR?.status === 'success' && phaseR.result !== undefined
          ? Number(phaseR.result)
          : 0;
      const amount = pendingR?.status === 'success' ? asUint(pendingR.result) : 0n;
      const claimableAmount = claimableR?.status === 'success' ? asUint(claimableR.result) : 0n;
      const claimOpenAt = openR?.status === 'success' ? asUint(openR.result) : 0n;

      if (amount <= 0n && claimableAmount <= 0n) continue;

      const canCancel = amount > 0n && !processed && phase === 0;
      const isStuck = amount > 0n && !processed && phase > 0;
      found.push({
        batchCycle: cycles[i],
        amount,
        claimableAmount,
        phase,
        processed,
        canCancel,
        isStuck,
        claimOpenAt,
      });
    }
    return found;
  }, [readResults, cycles]);

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
