import { createPublicClient, http, type Address } from 'viem';
import { arbitrum } from 'viem/chains';
import { AAVE_V3_POOL_ARBITRUM_ONE, ARBITRUM_ONE_RPC, SECONDS_PER_YEAR } from './constants';

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

/** Convert Aave RAY per-second rate to annualized APY (%). */
export function rayPerSecondToApyPct(ray: bigint): number {
  if (ray <= 0n) return 0;
  const ratePerSecond = Number(ray) / Number(RAY);
  if (!Number.isFinite(ratePerSecond) || ratePerSecond <= 0) return 0;
  return (Math.pow(1 + ratePerSecond, SECONDS_PER_YEAR) - 1) * 100;
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
    supplyApyPct: rayPerSecondToApyPct(reserve.currentLiquidityRate),
    borrowApyPct: rayPerSecondToApyPct(reserve.currentVariableBorrowRate),
  };
}
