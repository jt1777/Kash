'use client';

import {
  batchCapNotice,
  batchCapSummary,
  BATCH_USER_CAP,
} from '@/lib/batchUserCap';

type BatchKind = 'mint' | 'redeem';

export function BatchUserCapStatus({
  kind,
  usersCount,
  cap = BATCH_USER_CAP,
  batchProcessed,
  userAlreadyInBatch,
}: {
  kind: BatchKind;
  usersCount: number | null;
  cap?: number;
  batchProcessed: boolean;
  userAlreadyInBatch: boolean;
}) {
  if (usersCount === null) return null;

  const atCap = usersCount >= cap;
  const nearCap = !atCap && usersCount >= Math.floor(cap * 0.9);
  const blocked = atCap && !userAlreadyInBatch && !batchProcessed;

  if (batchProcessed) {
    return (
      <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
        <p className="text-sm text-gray-700">
          {batchCapSummary(kind, usersCount, cap)} — today&apos;s batch has finished processing. New
          requests join the next cycle.
        </p>
      </div>
    );
  }

  if (blocked) {
    return (
      <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
        <p className="text-sm font-semibold text-amber-900">{batchCapSummary(kind, usersCount, cap)}</p>
        <p className="text-sm text-amber-800 mt-1">{batchCapNotice(kind, usersCount, cap)}</p>
      </div>
    );
  }

  if (atCap && userAlreadyInBatch) {
    return (
      <div className="rounded-lg border border-blue-200 bg-blue-50 p-3">
        <p className="text-sm font-medium text-blue-900">{batchCapSummary(kind, usersCount, cap)}</p>
        <p className="text-sm text-blue-800 mt-1">
          The wallet limit is reached for new participants, but you already have a request this cycle
          and can add to it.
        </p>
      </div>
    );
  }

  const borderClass = nearCap ? 'border-amber-200 bg-amber-50/70' : 'border-gray-200 bg-gray-50';
  const textClass = nearCap ? 'text-amber-900' : 'text-gray-700';

  return (
    <div className={`rounded-lg border p-3 ${borderClass}`}>
      <p className={`text-sm ${textClass}`}>
        {batchCapSummary(kind, usersCount, cap)}. Each batch accepts up to {cap} unique wallets for{' '}
        {kind === 'mint' ? 'deposits' : 'redemptions'}.
        {nearCap ? ' Slots are almost gone — submit soon or wait for the next cycle.' : ''}
      </p>
    </div>
  );
}
