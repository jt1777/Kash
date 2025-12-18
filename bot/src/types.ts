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
