'use client';

import { arbiscanAddressUrl, isArbiscanVerifiedKashYield } from '@/lib/contracts/addresses';

type ContractVerifiedBadgeProps = {
  contractAddress: `0x${string}`;
  className?: string;
};

export function ContractVerifiedBadge({ contractAddress, className }: ContractVerifiedBadgeProps) {
  if (!isArbiscanVerifiedKashYield(contractAddress)) return null;

  return (
    <a
      href={arbiscanAddressUrl(contractAddress, { code: true })}
      target="_blank"
      rel="noopener noreferrer"
      className={[
        'inline-flex items-center gap-1.5 text-xs font-medium text-green-700 hover:text-green-800 transition',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <span aria-hidden className="text-green-600">
        ✓
      </span>
      Contract verified
      <span aria-hidden>↗</span>
    </a>
  );
}
