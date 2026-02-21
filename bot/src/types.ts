import { BigNumberish } from 'ethers';

export interface MintRequest {
  user: string;
  tokenIn: string;
  amountIn: bigint;
  amountInUSD: bigint;
  batchCycle: bigint;
}

export interface RedeemRequest {
  user: string;
  kashAmount: bigint;
  tokenOut: string;
  batchCycle: bigint;
}

export interface BatchInfo {
  totalMintUSD: bigint;
  totalRedeemUSD: bigint;
  processed: boolean;
  mintUsersCount: bigint;
  redeemUsersCount: bigint;
}

export interface NetPosition {
  netPositionUSD: bigint; // Positive = net mints, negative = net redeems
  totalMintUSD: bigint;
  totalRedeemUSD: bigint;
  mintCount: number;
  redeemCount: number;
  batchCycle: bigint;
}

export interface TokenPrice {
  address: string;
  price: bigint; // 18 decimals
  decimals: number;
}

/** Daily fees/earnings: Aave supply interest, Aave borrow cost, Hyperliquid funding. Net = earned - cost + funding (funding can be negative). */
export interface DailyYield {
  /** Interest earned on Aave deposits (supply), USD 18 decimals */
  aaveSupplyEarned: bigint;
  /** Interest/cost paid on Aave borrows, USD 18 decimals */
  aaveBorrowCost: bigint;
  /** Funding rate from Hyperliquid short (positive = we receive, negative = we pay), USD 18 decimals */
  hlFunding: bigint;
  /** Net: aaveSupplyEarned - aaveBorrowCost + hlFunding */
  netYield: bigint;
}
