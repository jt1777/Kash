import { formatUnits } from 'viem';

/** Landing page: 4 decimal places per KASH token. */
export function formatNavForLanding(nav: bigint | undefined): string {
  if (nav === undefined) return '—';
  return `$${Number(formatUnits(nav, 18)).toFixed(4)}`;
}

/** App stats: 6 decimal places (micro-dollar rounding, matches prior StatsCard behavior). */
export function formatNavForApp(nav: bigint | undefined): string {
  if (nav === undefined) return '1.000000';
  const microUnits = 10n ** 12n;
  const roundedMicro = (nav + microUnits / 2n) / microUnits;
  const whole = roundedMicro / 1_000_000n;
  const frac = roundedMicro % 1_000_000n;
  return `$${whole}.${frac.toString().padStart(6, '0')}`;
}

/** Landing page: compact USD for total NAV (nav × supply). */
export function formatTotalNavCompact(totalNav: bigint | undefined): string {
  if (totalNav === undefined) return '—';
  const num = Number(formatUnits(totalNav, 18));
  if (num >= 1_000_000) {
    return `$${(num / 1_000_000).toFixed(2)}M`;
  }
  return `$${num.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}
