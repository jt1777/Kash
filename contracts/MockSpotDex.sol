// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/ISpotDex.sol";

/**
 * @title MockSpotDex
 * @notice Test implementation of ISpotDex for Arbitrum Sepolia (or local Hardhat).
 *
 * Simulates token swaps at owner-configurable exchange rates. Does NOT route through
 * a real DEX — it simply holds both tokens and transfers them on each swap request.
 *
 * This is the testnet substitute for UniswapV3Adapter. Real Uniswap V3 pools for
 * MockWBTC/MockUSDC pairs do not exist on Sepolia, so this mock is required for
 * testing the full redemption flow (residual Aave debt repayment via spot swap).
 *
 * Usage:
 *   1. Deploy this contract.
 *   2. Set rates: setRate(wbtcAddr, usdcAddr, btcPrice * 1e16)  (see below for formulas)
 *   3. Fund with both tokens: fund(usdcAddr, amount) + fund(wbtcAddr, amount)
 *   4. Register on the main contract: kashYield.setSpotDex(mockSpotDexAddr)
 *
 * Rate formula (rate = amountOut per amountIn unit, scaled by 1e18):
 *   wBTC (8 dec)  → USDC (6 dec): rate = btcPriceUSD * 1e16
 *   USDC (6 dec)  → wBTC (8 dec): rate = 1e20 / btcPriceUSD
 *   ETH  (18 dec) → USDC (6 dec): rate = ethPriceUSD * 1e6
 *   USDC (6 dec)  → ETH  (18 dec): rate = 1e30 / ethPriceUSD
 *
 * Example at BTC = $45,000:
 *   wBTC → USDC: rate = 45000 * 1e16 = 4.5e20
 *   USDC → wBTC: rate = 1e20 / 45000 ≈ 2.222e15
 *
 * IMPORTANT: When you change the BTC/ETH price on MockChainlinkPriceFeed, also call
 * updateRatesForPrice() (or setRate() manually) so swap outputs stay in sync.
 */
contract MockSpotDex is ISpotDex {
    using SafeERC20 for IERC20;

    address public owner;

    /// @notice Exchange rate: rate[tokenIn][tokenOut] = amountOut per amountIn, scaled by 1e18.
    mapping(address => mapping(address => uint256)) public rates;

    event SwapExecuted(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut);
    event RateSet(address indexed tokenIn, address indexed tokenOut, uint256 rate);
    event Funded(address indexed token, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "MockSpotDex: only owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        owner = newOwner;
    }

    // ── Configuration ────────────────────────────────────────────────────

    /// @notice Set the exchange rate for tokenIn → tokenOut (scaled by 1e18).
    /// See contract-level comments for rate formulas.
    function setRate(address tokenIn, address tokenOut, uint256 rate) external onlyOwner {
        require(rate > 0, "MockSpotDex: rate must be > 0");
        rates[tokenIn][tokenOut] = rate;
        emit RateSet(tokenIn, tokenOut, rate);
    }

    /// @notice Convenience helper: set all four rates for a BTC product at once.
    /// @param wbtcAddress  wBTC ERC-20 address
    /// @param usdcAddress  USDC ERC-20 address
    /// @param btcPriceUsd  BTC price in USD (whole dollars, e.g. 45000)
    function setBtcRates(address wbtcAddress, address usdcAddress, uint256 btcPriceUsd) external onlyOwner {
        require(btcPriceUsd > 0, "MockSpotDex: price must be > 0");
        rates[wbtcAddress][usdcAddress] = btcPriceUsd * 1e16;
        rates[usdcAddress][wbtcAddress] = 1e20 / btcPriceUsd;
        emit RateSet(wbtcAddress, usdcAddress, btcPriceUsd * 1e16);
        emit RateSet(usdcAddress, wbtcAddress, 1e20 / btcPriceUsd);
    }

    /// @notice Convenience helper: set all four rates for an ETH product at once.
    /// @param usdcAddress  USDC ERC-20 address
    /// @param ethPriceUsd  ETH price in USD (whole dollars, e.g. 3000)
    /// address(0) represents native ETH as tokenIn/tokenOut
    function setEthRates(address usdcAddress, uint256 ethPriceUsd) external onlyOwner {
        require(ethPriceUsd > 0, "MockSpotDex: price must be > 0");
        rates[address(0)][usdcAddress] = ethPriceUsd * 1e6;
        rates[usdcAddress][address(0)] = 1e30 / ethPriceUsd;
        emit RateSet(address(0), usdcAddress, ethPriceUsd * 1e6);
        emit RateSet(usdcAddress, address(0), 1e30 / ethPriceUsd);
    }

    // ── Funding ──────────────────────────────────────────────────────────

    /// @notice Fund the mock with ERC-20 tokens so it can pay out on swaps.
    function fund(address token, uint256 amount) external {
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit Funded(token, amount);
    }

    /// @notice Fund the mock with native ETH (for ETH product payouts).
    function fundEth() external payable {
        emit Funded(address(0), msg.value);
    }

    /// @notice Withdraw ERC-20 tokens (cleanup / refund).
    function withdraw(address token, uint256 amount, address to) external onlyOwner {
        IERC20(token).safeTransfer(to, amount);
    }

    /// @notice Withdraw native ETH.
    function withdrawEth(uint256 amount, address payable to) external onlyOwner {
        (bool ok,) = to.call{value: amount}("");
        require(ok, "MockSpotDex: ETH withdraw failed");
    }

    /// @notice View ERC-20 balance held by this contract (convenience for scripts).
    function tokenBalance(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }

    // ── ISpotDex ─────────────────────────────────────────────────────────

    /// @inheritdoc ISpotDex
    function swapExactIn(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient
    ) external payable override returns (uint256 amountOut) {
        uint256 rate = rates[tokenIn][tokenOut];
        require(rate > 0, "MockSpotDex: rate not set for this pair");

        // Pull input tokens
        if (tokenIn == address(0)) {
            require(msg.value == amountIn, "MockSpotDex: ETH amount mismatch");
        } else {
            IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        }

        // Calculate output
        amountOut = amountIn * rate / 1e18;
        require(amountOut >= minAmountOut, "MockSpotDex: slippage exceeded");
        require(amountOut > 0, "MockSpotDex: zero output");

        // Pay output tokens
        if (tokenOut == address(0)) {
            require(address(this).balance >= amountOut, "MockSpotDex: insufficient ETH balance");
            (bool ok,) = recipient.call{value: amountOut}("");
            require(ok, "MockSpotDex: ETH payout failed");
        } else {
            require(IERC20(tokenOut).balanceOf(address(this)) >= amountOut, "MockSpotDex: insufficient token balance - call fund()");
            IERC20(tokenOut).safeTransfer(recipient, amountOut);
        }

        emit SwapExecuted(tokenIn, tokenOut, amountIn, amountOut);
    }

    receive() external payable {}
}
