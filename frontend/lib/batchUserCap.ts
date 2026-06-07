/** Matches on-chain MAX_MINT_USERS / MAX_REDEEM_USERS in KashYield* contracts. */
export const BATCH_USER_CAP = 500;

export const MINT_CAP_REACHED_SELECTOR = '0x5fb1eed1';
export const REDEEM_CAP_REACHED_SELECTOR = '0x94f90443';

export type BatchInfoRow = readonly [bigint, bigint, boolean, bigint, bigint, bigint];

export function mintUsersCountFromBatchInfo(batchInfo: BatchInfoRow | undefined): number | null {
  if (!batchInfo) return null;
  return Number(batchInfo[3]);
}

export function redeemUsersCountFromBatchInfo(batchInfo: BatchInfoRow | undefined): number | null {
  if (!batchInfo) return null;
  return Number(batchInfo[4]);
}

export function isBatchProcessed(batchInfo: BatchInfoRow | undefined): boolean {
  return batchInfo ? batchInfo[2] : false;
}

/** True when a new wallet cannot join this batch (existing participants may still add). */
export function isNewUserBlockedByBatchCap(
  usersCount: number | null,
  userAlreadyInBatch: boolean,
): boolean {
  if (usersCount === null) return false;
  return usersCount >= BATCH_USER_CAP && !userAlreadyInBatch;
}

export function batchCapNotice(kind: 'mint' | 'redeem', usersCount: number): string {
  const action = kind === 'mint' ? 'mint' : 'redeem';
  return `This batch cycle already has ${usersCount} wallets with ${action} requests (limit ${BATCH_USER_CAP}). New wallets cannot join until the next cycle or someone cancels. If you already submitted this cycle, you can add to your existing request.`;
}

function errorPayloadIncludes(error: unknown, needle: string, depth = 0): boolean {
  if (error == null || depth > 5) return false;
  const n = needle.toLowerCase();
  if (typeof error === 'string') return error.toLowerCase().includes(n);
  if (typeof error === 'object') {
    const o = error as Record<string, unknown>;
    for (const key of ['data', 'message', 'shortMessage', 'details'] as const) {
      const v = o[key];
      if (typeof v === 'string' && v.toLowerCase().includes(n)) return true;
    }
    if (o.cause) return errorPayloadIncludes(o.cause, needle, depth + 1);
  }
  return false;
}

export function isMintCapReachedError(error: unknown): boolean {
  return errorPayloadIncludes(error, MINT_CAP_REACHED_SELECTOR);
}

export function isRedeemCapReachedError(error: unknown): boolean {
  return errorPayloadIncludes(error, REDEEM_CAP_REACHED_SELECTOR);
}
