import { ethers } from 'ethers';
import type { DailyYield } from '../types';
import { config } from '../config';

// Mock Aave V3 views (optional – only present on MockAaveV3)
const MOCK_AAVE_VIEWS_ABI = [
  'function getAccruedSupplyYieldEth(address user) view returns (uint256)',
  'function getEstimatedDailyBorrowInterestUsd(address user) view returns (uint256)',
  'function ethPriceInUsd() view returns (uint256)',
];
// Mock Hyperliquid funding view (optional – only present on MockHyperliquid)
const MOCK_HL_VIEWS_ABI = [
  'function getAccruedFundingUsd(address user, string calldata symbol) view returns (int256)',
];

/**
 * Daily yield = Aave supply interest (earned) - Aave borrow cost + Hyperliquid funding.
 * Used to update NAV before processBatch so redeems reflect net fees/earnings.
 *
 * Real Aave (e.g. Arbitrum Sepolia): does not expose these mock views; try/catch returns 0 until you
 * implement supply/borrow yield via reserve liquidityIndex and variableBorrowIndex (or a subgraph).
 * MockAaveV3: uses getAccruedSupplyYieldEth and getEstimatedDailyBorrowInterestUsd (USD 18).
 * MockHyperliquid: uses getAccruedFundingUsd(user, "ETH") + getAccruedFundingUsd(user, "BTC") (USD 18). Real HL: use API or 0.
 */
export async function getDailyYield(
  provider: ethers.Provider,
  options?: {
    kashYield?: ethers.Contract;
    aavePoolAddress?: string;
    aaveUserAddress?: string;
  }
): Promise<DailyYield> {
  const aavePoolAddress = options?.aavePoolAddress ?? config.aavePoolAddress;
  const aaveUser = (options?.aaveUserAddress || config.aaveUserAddress || config.kashYieldAddress) || '';
  const kashYield = options?.kashYield;

  let aaveSupplyEarned = 0n;
  let aaveBorrowCost = 0n;
  let hlFunding = 0n;

  // ----- MockAaveV3: supply yield (ETH) and daily borrow interest (USD 18)
  if (aavePoolAddress && aaveUser) {
    try {
      const aavePool = new ethers.Contract(aavePoolAddress, MOCK_AAVE_VIEWS_ABI, provider);
      const [supplyYieldEth, borrowCostUsd] = await Promise.all([
        aavePool.getAccruedSupplyYieldEth(aaveUser),
        aavePool.getEstimatedDailyBorrowInterestUsd(aaveUser),
      ]);
      // Supply yield in USD 18: supplyYieldEth * ethPriceInUsd / 1e18
      const ethPrice = await aavePool.ethPriceInUsd();
      aaveSupplyEarned = (BigInt(supplyYieldEth.toString()) * BigInt(ethPrice.toString())) / 10n ** 18n;
      aaveBorrowCost = BigInt(borrowCostUsd.toString());
    } catch {
      // Real Aave or missing mock views – leave 0
    }
  }

  // ----- MockHyperliquid: accrued funding (USD 18, positive = we receive)
  if (kashYield) {
    try {
      const hlAddress = await kashYield.hyperliquidAddress();
      if (hlAddress && hlAddress !== ethers.ZeroAddress) {
        const hl = new ethers.Contract(hlAddress, MOCK_HL_VIEWS_ABI, provider);
        const kashYieldAddress = await kashYield.getAddress?.() ?? config.kashYieldAddress;
        const [fundingEth, fundingBtc] = await Promise.all([
          hl.getAccruedFundingUsd(kashYieldAddress, 'ETH'),
          hl.getAccruedFundingUsd(kashYieldAddress, 'BTC'),
        ]);
        hlFunding = BigInt(fundingEth.toString()) + BigInt(fundingBtc.toString());
      }
    } catch {
      // Real HL or missing mock view – leave 0
    }
  }

  const netYield = aaveSupplyEarned - aaveBorrowCost + hlFunding;

  return {
    aaveSupplyEarned,
    aaveBorrowCost,
    hlFunding,
    netYield,
  };
}

/**
 * Compute NAV to use for this batch: (portfolioValueUSD + netYield) / totalKashSupply.
 * Call updateNAV(newNAV) before processBatch() so redeems use this NAV.
 * All amounts in 18 decimals.
 */
export function computeNAVFromPortfolioAndYield(
  portfolioValueUSD: bigint,
  netYield: bigint,
  totalKashSupply: bigint
): bigint {
  if (totalKashSupply === 0n) return 0n;
  return (portfolioValueUSD + netYield) / totalKashSupply;
}
