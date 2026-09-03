'use client';

import { useMemo } from 'react';
import { useReadContract } from 'wagmi';
import {
  CONTRACTS,
  hasBtcProduct,
  hasEthProduct,
} from '@/lib/contracts/addresses';
import { vaultAbi } from '@/lib/contracts/vaultAbi';
import type { StrategyYieldProduct } from '@/lib/strategyYield';
import { useStrategyYield } from '@/hooks/useStrategyYield';

export type VaultMetricsProduct = StrategyYieldProduct;

type ProductConfig = {
  enabled: boolean;
  kashYield: `0x${string}`;
  kashToken: `0x${string}`;
  productName: string;
};

function getProductConfig(product: VaultMetricsProduct): ProductConfig {
  if (product === 'btc') {
    return {
      enabled: hasBtcProduct(),
      kashYield: CONTRACTS.kashYieldBtc,
      kashToken: CONTRACTS.kashTokenBtc,
      productName: 'KASH-BTC',
    };
  }
  return {
    enabled: hasEthProduct(),
    kashYield: CONTRACTS.kashYieldEth,
    kashToken: CONTRACTS.kashTokenEth,
    productName: 'KASH-ETH',
  };
}

/** On-chain NAV + total NAV + indicative P.A. yield for one KASH product. */
export function useVaultMetrics(product: VaultMetricsProduct) {
  const { enabled, kashYield, kashToken, productName } = getProductConfig(product);

  const {
    data: nav,
    refetch: refetchNav,
    isFetching: isNavFetching,
    isLoading: isNavLoading,
  } = useReadContract({
    address: kashYield,
    abi: vaultAbi(product),
    functionName: 'getNAV',
    query: { enabled },
  });

  const {
    data: totalSupply,
    isFetching: isSupplyFetching,
    isLoading: isSupplyLoading,
  } = useReadContract({
    address: kashToken,
    abi: vaultAbi(product),
    functionName: 'totalSupply',
    query: { enabled },
  });

  const yieldQuery = useStrategyYield(product);

  const totalNav = useMemo(() => {
    if (nav === undefined || totalSupply === undefined) return undefined;
    return (nav * totalSupply) / 10n ** 18n;
  }, [nav, totalSupply]);

  const isOnChainLoading =
    enabled && (isNavLoading || isSupplyLoading || isNavFetching || isSupplyFetching);

  return {
    product,
    productName,
    enabled,
    kashYield,
    kashToken,
    nav,
    totalNav,
    yield: yieldQuery,
    refetchNav,
    refetchYield: yieldQuery.refetch,
    isNavFetching,
    isOnChainLoading,
  };
}
