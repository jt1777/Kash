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
  cap: number = BATCH_USER_CAP,
): boolean {
  if (usersCount === null) return false;
  return usersCount >= cap && !userAlreadyInBatch;
}

export function batchCapLabel(kind: 'mint' | 'redeem'): string {
  return kind === 'mint' ? 'Mint' : 'Redeem';
}

export type BatchCapStatusLevel = 'available' | 'mostly-full' | 'almost-full' | 'full';

/** Status bands for the batch wallet cap (500 max on-chain). */
export function getBatchCapStatusLevel(
  usersCount: number,
  cap: number = BATCH_USER_CAP,
): BatchCapStatusLevel {
  if (usersCount >= cap) return 'full';
  if (usersCount >= 476) return 'almost-full';
  if (usersCount >= 401) return 'mostly-full';
  return 'available';
}

export function batchCapStatusLabel(level: BatchCapStatusLevel): string {
  switch (level) {
    case 'available':
      return 'Available';
    case 'mostly-full':
      return 'Mostly full';
    case 'almost-full':
      return 'Almost full';
    case 'full':
      return 'Full';
  }
}

export function batchCapSummary(
  kind: 'mint' | 'redeem',
  usersCount: number,
  cap: number = BATCH_USER_CAP,
): string {
  const label = batchCapLabel(kind);
  const level = getBatchCapStatusLevel(usersCount, cap);
  return `${label} batch: ${batchCapStatusLabel(level)}`;
}

export function batchCapNotice(kind: 'mint' | 'redeem'): string {
  const action = kind === 'mint' ? 'mint' : 'redeem';
  return `This batch cycle is full for new ${action} requests. New wallets cannot join until the next cycle or someone cancels. If you already submitted this cycle, you can add to your existing request.`;
}

export function batchCapSubmitLabel(
  kind: 'mint' | 'redeem',
  blocked: boolean,
): string {
  if (!blocked) {
    return kind === 'mint' ? 'Submit Mint Request' : 'Submit Redeem Request';
  }
  return kind === 'mint' ? 'Mint batch full' : 'Redeem batch full';
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
