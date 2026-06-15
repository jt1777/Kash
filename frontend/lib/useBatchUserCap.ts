'use client';

import { useReadContract, useReadContracts } from 'wagmi';
import { kashYieldABI } from '@/lib/contracts/kashYieldABI';
import {
  BATCH_USER_CAP,
  type BatchInfoRow,
  isBatchProcessed,
  isNewUserBlockedByBatchCap,
  mintUsersCountFromBatchInfo,
  redeemUsersCountFromBatchInfo,
} from '@/lib/batchUserCap';

function readUint(result: unknown): number | null {
  if (result === undefined || result === null) return null;
  return Number(result as bigint);
}

export function useBatchUserCap(kashYield: `0x${string}` | undefined) {
  const { data: currentBatchCycle } = useReadContract({
    address: kashYield,
    abi: kashYieldABI,
    functionName: 'getCurrentBatchCycle',
  });

  const batchCycleReady = currentBatchCycle !== undefined;
  const batchCycleArg = batchCycleReady ? ([currentBatchCycle] as const) : undefined;

  const { data: reads } = useReadContracts({
    contracts:
      kashYield && batchCycleArg
        ? [
            { address: kashYield, abi: kashYieldABI, functionName: 'getBatchInfo', args: batchCycleArg },
            { address: kashYield, abi: kashYieldABI, functionName: 'activeMintUsers', args: batchCycleArg },
            { address: kashYield, abi: kashYieldABI, functionName: 'activeRedeemUsers', args: batchCycleArg },
          ]
        : [],
    query: { enabled: Boolean(kashYield && batchCycleArg), refetchInterval: 15_000 },
  });

  const batchInfo =
    reads?.[0]?.status === 'success' ? (reads[0].result as BatchInfoRow) : undefined;
  const activeMintUsers =
    reads?.[1]?.status === 'success' ? readUint(reads[1].result) : null;
  const activeRedeemUsers =
    reads?.[2]?.status === 'success' ? readUint(reads[2].result) : null;

  const batchProcessed = isBatchProcessed(batchInfo);
  const mintUsersCount = activeMintUsers ?? mintUsersCountFromBatchInfo(batchInfo);
  const redeemUsersCount = activeRedeemUsers ?? redeemUsersCountFromBatchInfo(batchInfo);

  function mintBlocked(userAlreadyInBatch: boolean): boolean {
    return isNewUserBlockedByBatchCap(mintUsersCount, userAlreadyInBatch, BATCH_USER_CAP) && !batchProcessed;
  }

  function redeemBlocked(userAlreadyInBatch: boolean): boolean {
    return isNewUserBlockedByBatchCap(redeemUsersCount, userAlreadyInBatch, BATCH_USER_CAP) && !batchProcessed;
  }

  return {
    currentBatchCycle,
    batchProcessed,
    mintUsersCount,
    redeemUsersCount,
    batchUserCap: BATCH_USER_CAP,
    mintBlocked,
    redeemBlocked,
  };
}
