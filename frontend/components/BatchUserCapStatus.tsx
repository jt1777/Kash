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
      <div
        className="rounded-lg border p-3"
        style={{ backgroundColor: 'rgba(255, 255, 255, 0.08)', borderColor: 'rgba(255, 255, 255, 0.18)' }}
      >
        <p className="text-sm text-white/80">
          {batchCapSummary(kind, usersCount, cap)} — today&apos;s batch has finished processing. New
          requests join the next cycle.
        </p>
      </div>
    );
  }

  if (blocked) {
    return (
      <div
        className="rounded-lg border p-3"
        style={{ backgroundColor: 'rgba(245, 158, 11, 0.16)', borderColor: 'rgba(245, 158, 11, 0.35)' }}
      >
        <p className="text-sm font-semibold text-amber-100">{batchCapSummary(kind, usersCount, cap)}</p>
        <p className="text-sm text-amber-100/90 mt-1">{batchCapNotice(kind, usersCount, cap)}</p>
      </div>
    );
  }

  if (atCap && userAlreadyInBatch) {
    return (
      <div
        className="rounded-lg border p-3"
        style={{ backgroundColor: 'rgba(59, 130, 246, 0.16)', borderColor: 'rgba(59, 130, 246, 0.35)' }}
      >
        <p className="text-sm font-medium text-blue-100">{batchCapSummary(kind, usersCount, cap)}</p>
        <p className="text-sm text-blue-100/90 mt-1">
          The wallet limit is reached for new participants, but you already have a request this cycle
          and can add to it.
        </p>
      </div>
    );
  }

  if (nearCap) {
    return (
      <div
        className="rounded-lg border p-3"
        style={{ backgroundColor: 'rgba(245, 158, 11, 0.16)', borderColor: 'rgba(245, 158, 11, 0.35)' }}
      >
        <p className="text-sm text-amber-100">
          {batchCapSummary(kind, usersCount, cap)}. Each batch accepts up to {cap} unique wallets for{' '}
          {kind === 'mint' ? 'deposits' : 'redemptions'}. Slots are almost gone — submit soon or wait
          for the next cycle.
        </p>
      </div>
    );
  }

  return (
    <div
      className="rounded-lg border p-3"
      style={{ backgroundColor: 'rgba(0, 255, 255, 0.08)', borderColor: 'rgba(0, 255, 255, 0.22)' }}
    >
      <p className="text-sm text-cyan-50">
        {batchCapSummary(kind, usersCount, cap)}. Each batch accepts up to {cap} unique wallets for{' '}
        {kind === 'mint' ? 'deposits' : 'redemptions'}.
      </p>
    </div>
  );
}
