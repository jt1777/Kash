// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/ISpotDex.sol";

/// @dev Uniswap V3 SwapRouter interface (same on all EVM chains).
interface IUniswapV3SwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24  fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/// @dev WETH interface for native ETH wrapping.
interface IWETH9 is IERC20 {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

/**
 * @title UniswapV3Adapter
 * @notice ISpotDex adapter for Uniswap V3. Supports wBTC ↔ USDC and ETH ↔ USDC swaps.
 *
 * Used by KashYieldBtc/ETH to cover residual Aave debt when the perp position's
 * P&L doesn't fully repay the USDC borrow (typically in rising-price scenarios).
 *
 * The fee tier for each pool is configurable per token-pair (default 0.3% = 3000).
 *
 * TESTNET / MAINNET: Uniswap V3 is deployed on Arbitrum with the same ISwapRouter
 * interface. Only pool fee tiers and token addresses differ between networks.
 * Arbitrum Mainnet SwapRouter: 0xE592427A0AEce92De3Edee1F18E0157C05861564
 * Arbitrum Sepolia SwapRouter: 0x101F443B4d1b059569D643917553c771E1b9663E
 */
contract UniswapV3Adapter is ISpotDex {
    using SafeERC20 for IERC20;

    IUniswapV3SwapRouter public immutable swapRouter;
    address public immutable wethAddress; // Wrapped ETH for native ETH swaps

    address public owner;
    address public pendingOwner;

    /// @notice Default fee tier (basis points * 100). 3000 = 0.3%, 500 = 0.05%, 10000 = 1%.
    uint24 public defaultFeeTier = 3000;
    /// @notice Override fee tier per tokenIn+tokenOut pair (0 = use defaultFeeTier).
    mapping(address => mapping(address => uint24)) public feeTierOverride;

    event SwapExecuted(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut);

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner");
        _;
    }

    constructor(address _swapRouter, address _wethAddress) {
        swapRouter  = IUniswapV3SwapRouter(_swapRouter);
        wethAddress = _wethAddress;
        owner = msg.sender;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
    }
    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "Not pending owner");
        owner = pendingOwner;
        pendingOwner = address(0);
    }

    /// @notice Set a specific fee tier for a tokenIn → tokenOut pair.
    function setFeeTierOverride(address tokenIn, address tokenOut, uint24 fee) external onlyOwner {
        feeTierOverride[tokenIn][tokenOut] = fee;
    }

    function setDefaultFeeTier(uint24 fee) external onlyOwner {
        defaultFeeTier = fee;
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
        address effectiveTokenIn = tokenIn;

        if (tokenIn == address(0)) {
            // Native ETH → wrap to WETH, then swap WETH → tokenOut
            require(msg.value == amountIn, "ETH amount mismatch");
            IWETH9(wethAddress).deposit{value: amountIn}();
            effectiveTokenIn = wethAddress;
        } else {
            IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        }

        IERC20(effectiveTokenIn).forceApprove(address(swapRouter), amountIn);

        uint24 fee = feeTierOverride[effectiveTokenIn][tokenOut];
        if (fee == 0) fee = defaultFeeTier;

        IUniswapV3SwapRouter.ExactInputSingleParams memory params = IUniswapV3SwapRouter.ExactInputSingleParams({
            tokenIn:           effectiveTokenIn,
            tokenOut:          tokenOut,
            fee:               fee,
            recipient:         recipient,
            deadline:          block.timestamp + 60,
            amountIn:          amountIn,
            amountOutMinimum:  minAmountOut,
            sqrtPriceLimitX96: 0
        });

        amountOut = swapRouter.exactInputSingle(params);
        emit SwapExecuted(tokenIn, tokenOut, amountIn, amountOut);
    }

    receive() external payable {}
}
