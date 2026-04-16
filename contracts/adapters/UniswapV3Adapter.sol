// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/ISpotDex.sol";

/// @dev Uniswap **SwapRouter02** `exactInputSingle` (IV3SwapRouter) — **no `deadline` field**.
/// SwapRouter01 (`0xE592…`) used a larger struct with `deadline`; encoding that against Router02
/// mis-aligns ABI slots and swaps revert with empty data. Production Arbitrum uses Router02
/// (`0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45`).
interface IUniswapV3SwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
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
 * Used by KashYieldBtc/ETH to:
 *   - Swap ETH/wBTC → USDC when perp P&L doesn't fully cover the Aave debt (rising price)
 *   - Swap USDC → ETH/wBTC when short profits exceed Aave debt and extra collateral is needed (falling price)
 *
 * The fee tier per pool is configurable (default 0.05% = 500), which matches the main
 * WETH/USDC and wBTC/USDC pools on Arbitrum. Override per pair if needed.
 *
 * Pass **SwapRouter02** only (do not use SwapRouter01 — different `exactInputSingle` struct).
 *   Arbitrum One (mainnet): 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45
 *   Arbitrum Sepolia:       0x101F443B4d1b059569D643917553c771E1b9663E
 *
 * WETH addresses:
 *   Arbitrum One:    0x82aF49447D8a07e3bd95BD0d56f35241523fBab1
 *   Arbitrum Sepolia: 0x980B62Da83eFf3D4576C647993b0c1D7faf17c73
 */
contract UniswapV3Adapter is ISpotDex {
    using SafeERC20 for IERC20;

    IUniswapV3SwapRouter public immutable swapRouter;
    address public immutable wethAddress; // Wrapped ETH for native ETH swaps

    address public owner;
    address public pendingOwner;

    /// @notice Default fee tier (basis points * 100). 500 = 0.05%, 3000 = 0.3%, 10000 = 1%.
    /// 0.05% is the primary fee tier for WETH/USDC and wBTC/USDC on Arbitrum mainnet.
    uint24 public defaultFeeTier = 500;
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
        address effectiveTokenIn  = tokenIn;
        address effectiveTokenOut = tokenOut;

        if (tokenIn == address(0)) {
            // Native ETH in → wrap to WETH, swap WETH → tokenOut
            require(msg.value == amountIn, "ETH amount mismatch");
            IWETH9(wethAddress).deposit{value: amountIn}();
            effectiveTokenIn = wethAddress;
        } else {
            IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        }

        // ETH out → swap to WETH here, unwrap after
        bool nativeEthOut = tokenOut == address(0);
        if (nativeEthOut) {
            effectiveTokenOut = wethAddress;
        }

        IERC20(effectiveTokenIn).forceApprove(address(swapRouter), amountIn);

        uint24 fee = feeTierOverride[effectiveTokenIn][effectiveTokenOut];
        if (fee == 0) fee = defaultFeeTier;

        IUniswapV3SwapRouter.ExactInputSingleParams memory params = IUniswapV3SwapRouter.ExactInputSingleParams({
            tokenIn: effectiveTokenIn,
            tokenOut: effectiveTokenOut,
            fee: fee,
            recipient: nativeEthOut ? address(this) : recipient,
            amountIn: amountIn,
            amountOutMinimum: minAmountOut,
            sqrtPriceLimitX96: 0
        });

        amountOut = swapRouter.exactInputSingle(params);

        if (nativeEthOut) {
            // Unwrap WETH → native ETH and forward to the original recipient
            IWETH9(wethAddress).withdraw(amountOut);
            (bool ok,) = recipient.call{value: amountOut}("");
            require(ok, "ETH transfer failed");
        }

        emit SwapExecuted(tokenIn, tokenOut, amountIn, amountOut);
    }

    receive() external payable {}
}
