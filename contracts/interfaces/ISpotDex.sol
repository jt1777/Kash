// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

/**
 * @title ISpotDex
 * @notice Minimal interface for on-chain spot DEX adapters (Uniswap V3, etc.).
 *
 * Used by the main KashYield contracts to convert between the base asset
 * (wBTC / ETH) and USDC when the perp position P&L doesn't fully cover
 * the Aave debt repayment (typically in a rising-price scenario).
 */
interface ISpotDex {
    /// @notice Swap exactly `amountIn` of `tokenIn` for at least `minAmountOut` of `tokenOut`.
    /// For ETH-in swaps, msg.value must equal amountIn and tokenIn must be address(0).
    /// For ERC-20 inputs, caller must approve this adapter for `amountIn` beforehand.
    /// @param tokenIn      Input token (address(0) = native ETH).
    /// @param tokenOut     Output token.
    /// @param amountIn     Exact input amount.
    /// @param minAmountOut Minimum acceptable output — reverts if not met (slippage guard).
    /// @param recipient    Address to receive the output tokens.
    /// @return amountOut   Actual output received.
    function swapExactIn(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient
    ) external payable returns (uint256 amountOut);
}
