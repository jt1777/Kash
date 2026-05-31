'use client';

import { useQuery } from '@tanstack/react-query';
import type { StrategyYieldProduct, StrategyYieldResponse } from '@/lib/strategyYield';

async function fetchStrategyYield(product: StrategyYieldProduct): Promise<StrategyYieldResponse> {
  const res = await fetch(`/api/strategy-yield?product=${product}`, { cache: 'no-store' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export function useStrategyYield(product: StrategyYieldProduct) {
  return useQuery({
    queryKey: ['strategy-yield', product],
    queryFn: () => fetchStrategyYield(product),
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: 1,
  });
}
