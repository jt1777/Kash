'use client';

import { useReadContract, useReadContracts } from 'wagmi';
import { vaultAbi, type VaultProduct } from '@/lib/contracts/vaultAbi';
import {
  BATCH_USER_CAP,
  isNewUserBlockedByBatchCap,
} from '@/lib/batchUserCap';

function readUint(result: unknown): number | null {
  if (result === undefined || result === null) return null;
  return Number(result as bigint);
}

export function useBatchUserCap(
  kashYield: `0x${string}` | undefined,
  product: VaultProduct = 'eth',
) {
  const abi = vaultAbi(product);

  const { data: currentBatchCycle } = useReadContract({
    address: kashYield,
    abi,
    functionName: 'getCurrentBatchCycle',
  });

  const batchCycleReady = currentBatchCycle !== undefined;
  const batchCycleArg = batchCycleReady ? ([currentBatchCycle] as const) : undefined;

  const { data: reads } = useReadContracts({
    contracts:
      kashYield && batchCycleArg
        ? [
            { address: kashYield, abi, functionName: 'batchProcessed', args: batchCycleArg },
            { address: kashYield, abi, functionName: 'activeDepositUsers', args: batchCycleArg },
            { address: kashYield, abi, functionName: 'activeRedeemUsers', args: batchCycleArg },
          ]
        : [],
    query: { enabled: Boolean(kashYield && batchCycleArg), refetchInterval: 15_000 },
  });

  const batchProcessed = reads?.[0]?.status === 'success' ? Boolean(reads[0].result) : false;
  const mintUsersCount =
    reads?.[1]?.status === 'success' ? readUint(reads[1].result) : null;
  const redeemUsersCount =
    reads?.[2]?.status === 'success' ? readUint(reads[2].result) : null;

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
