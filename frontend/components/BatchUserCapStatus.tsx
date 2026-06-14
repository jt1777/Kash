'use client';

import type { CSSProperties } from 'react';
import {
  BATCH_USER_CAP,
  batchCapLabel,
  batchCapNotice,
  batchCapStatusLabel,
  getBatchCapStatusLevel,
  type BatchCapStatusLevel,
} from '@/lib/batchUserCap';

type BatchKind = 'mint' | 'redeem';

function statusStyles(level: BatchCapStatusLevel): {
  container: CSSProperties;
  dot: CSSProperties;
  label: CSSProperties;
} {
  switch (level) {
    case 'available':
      return {
        container: { backgroundColor: 'rgba(34, 197, 94, 0.12)', borderColor: 'rgba(34, 197, 94, 0.35)' },
        dot: { backgroundColor: '#22c55e', boxShadow: '0 0 8px rgba(34, 197, 94, 0.6)' },
        label: { color: '#bbf7d0' },
      };
    case 'mostly-full':
      return {
        container: { backgroundColor: 'rgba(245, 158, 11, 0.16)', borderColor: 'rgba(245, 158, 11, 0.35)' },
        dot: { backgroundColor: '#f59e0b', boxShadow: '0 0 8px rgba(245, 158, 11, 0.5)' },
        label: { color: '#fde68a' },
      };
    case 'almost-full':
    case 'full':
      return {
        container: { backgroundColor: 'rgba(239, 68, 68, 0.14)', borderColor: 'rgba(239, 68, 68, 0.35)' },
        dot: { backgroundColor: '#ef4444', boxShadow: '0 0 8px rgba(239, 68, 68, 0.5)' },
        label: { color: '#fecaca' },
      };
  }
}

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

  const level = getBatchCapStatusLevel(usersCount, cap);
  const atCap = level === 'full';
  const blocked = atCap && !userAlreadyInBatch && !batchProcessed;
  const styles = statusStyles(level);

  if (batchProcessed) {
    return (
      <div
        className="rounded-lg border p-3"
        style={{ backgroundColor: 'rgba(255, 255, 255, 0.08)', borderColor: 'rgba(255, 255, 255, 0.18)' }}
      >
        <div className="flex items-center gap-2">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full shrink-0"
            style={{ backgroundColor: 'rgba(255, 255, 255, 0.45)' }}
            aria-hidden
          />
          <span className="text-sm font-medium text-white/90">{batchCapLabel(kind)} batch:</span>
          <span className="text-sm text-white/70">Closed</span>
        </div>
        <p className="text-sm text-white/70 mt-2">
          Today&apos;s batch has finished processing. New requests join the next cycle.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border p-3" style={styles.container}>
      <div className="flex items-center gap-2">
        <span
          className="inline-block h-2.5 w-2.5 rounded-full shrink-0"
          style={styles.dot}
          aria-hidden
        />
        <span className="text-sm font-medium text-white/90">{batchCapLabel(kind)} batch:</span>
        <span className="text-sm font-semibold" style={styles.label}>
          {batchCapStatusLabel(level)}
        </span>
      </div>

      {blocked && (
        <p className="text-sm mt-2" style={{ color: 'rgba(254, 202, 202, 0.95)' }}>
          {batchCapNotice(kind)}
        </p>
      )}

      {atCap && userAlreadyInBatch && (
        <p className="text-sm mt-2 text-blue-100/90">
          The wallet limit is reached for new participants, but you already have a request this cycle
          and can add to it.
        </p>
      )}

      {level === 'mostly-full' && (
        <p className="text-sm mt-2" style={{ color: 'rgba(253, 230, 138, 0.95)' }}>
          Slots are filling up — submit soon or wait for the next cycle.
        </p>
      )}

      {level === 'almost-full' && !blocked && (
        <p className="text-sm mt-2" style={{ color: 'rgba(254, 202, 202, 0.95)' }}>
          Almost no slots left — submit soon or wait for the next cycle.
        </p>
      )}
    </div>
  );
}
