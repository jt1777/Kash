import { createPublicClient, http, type Address } from 'viem';
import { arbitrum } from 'viem/chains';
import { AAVE_V3_POOL_ARBITRUM_ONE, ARBITRUM_ONE_RPC } from './constants';

const RAY = 10n ** 27n;

const aavePoolAbi = [
  {
    inputs: [{ name: 'asset', type: 'address' }],
    name: 'getReserveData',
    outputs: [
      {
        components: [
          { name: 'configuration', type: 'uint256' },
          { name: 'liquidityIndex', type: 'uint128' },
          { name: 'currentLiquidityRate', type: 'uint128' },
          { name: 'variableBorrowIndex', type: 'uint128' },
          { name: 'currentVariableBorrowRate', type: 'uint128' },
          { name: 'currentStableBorrowRate', type: 'uint128' },
          { name: 'lastUpdateTimestamp', type: 'uint40' },
          { name: 'id', type: 'uint16' },
          { name: 'aTokenAddress', type: 'address' },
          { name: 'stableDebtTokenAddress', type: 'address' },
          { name: 'variableDebtTokenAddress', type: 'address' },
          { name: 'interestRateStrategyAddress', type: 'address' },
          { name: 'accruedToTreasury', type: 'uint128' },
          { name: 'unbacked', type: 'uint128' },
          { name: 'isolationModeTotalDebt', type: 'uint128' },
        ],
        name: '',
        type: 'tuple',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

/** Aave V3 reserve rate in RAY (27 dec) is an annual rate — convert to APY display (%). */
export function rayAnnualRateToApyPct(ray: bigint): number {
  if (ray <= 0n) return 0;
  const annual = Number(ray) / Number(RAY);
  if (!Number.isFinite(annual) || annual <= 0) return 0;
  return annual * 100;
}

export async function fetchAaveReserveApyPct(
  assetAddress: Address,
  rpcUrl = ARBITRUM_ONE_RPC,
): Promise<{ supplyApyPct: number; borrowApyPct: number }> {
  const client = createPublicClient({
    chain: arbitrum,
    transport: http(rpcUrl, { timeout: 15_000 }),
  });

  const reserve = await client.readContract({
    address: AAVE_V3_POOL_ARBITRUM_ONE,
    abi: aavePoolAbi,
    functionName: 'getReserveData',
    args: [assetAddress],
  });

  return {
    supplyApyPct: rayAnnualRateToApyPct(reserve.currentLiquidityRate),
    borrowApyPct: rayAnnualRateToApyPct(reserve.currentVariableBorrowRate),
  };
}
