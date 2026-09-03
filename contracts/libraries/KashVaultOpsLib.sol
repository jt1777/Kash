// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/ISpotDex.sol";
import "./ProtocolActionCodes.sol";

interface IAavePoolOps {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
    function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf) external;
    function repay(address asset, uint256 amount, uint256 rateMode, address onBehalfOf) external returns (uint256);
}

error SlippageExceeded();

library KashVaultOpsLib {
    using SafeERC20 for IERC20;

    function depositToAave(address pool, address asset, uint256 amount) external {
        IERC20(asset).forceApprove(pool, amount);
        IAavePoolOps(pool).supply(asset, amount, address(this), 0);
        emit ProtocolInteraction(ProtocolActionCodes.AAVE_DEPOSIT, asset, amount);
    }

    function withdrawFromAave(address pool, address asset, uint256 amount) external {
        IAavePoolOps(pool).withdraw(asset, amount, address(this));
        emit ProtocolInteraction(ProtocolActionCodes.AAVE_WITHDRAW, asset, amount);
    }

    function borrowFromAave(address pool, address token, uint256 amount) external {
        IAavePoolOps(pool).borrow(token, amount, 2, 0, address(this));
        emit ProtocolInteraction(ProtocolActionCodes.AAVE_BORROW, token, amount);
    }

    function repayToAave(address pool, address token, uint256 amount) external {
        IERC20(token).forceApprove(pool, amount);
        IAavePoolOps(pool).repay(token, amount, 2, address(this));
        emit ProtocolInteraction(ProtocolActionCodes.AAVE_REPAY, token, amount);
    }

    function addCollateralToAave(address pool, address asset, uint256 amount) external {
        IERC20(asset).forceApprove(pool, amount);
        IAavePoolOps(pool).supply(asset, amount, address(this), 0);
        emit ProtocolInteraction(ProtocolActionCodes.AAVE_ADD_COLLATERAL, asset, amount);
    }

    function swapForUsdc(
        address spotDex,
        address asset,
        address usdc,
        uint256 assetAmount,
        uint256 minOut,
        uint256 maxSlippageBps
    ) external returns (uint256 usdcOut) {
        uint256 floor = _floor(spotDex, asset, usdc, assetAmount, maxSlippageBps);
        uint256 effective = minOut > floor ? minOut : floor;
        IERC20(asset).forceApprove(spotDex, assetAmount);
        usdcOut = ISpotDex(spotDex).swapExactIn(asset, usdc, assetAmount, effective, address(this));
        if (usdcOut < effective) revert SlippageExceeded();
        emit ProtocolInteraction(ProtocolActionCodes.DEX_SWAP_FOR_USDC, usdc, usdcOut);
    }

    function swapFromUsdc(
        address spotDex,
        address asset,
        address usdc,
        uint256 usdcAmount,
        uint256 minOut,
        uint256 maxSlippageBps
    ) external returns (uint256 assetOut) {
        uint256 floor = _floor(spotDex, usdc, asset, usdcAmount, maxSlippageBps);
        uint256 effective = minOut > floor ? minOut : floor;
        IERC20(usdc).forceApprove(spotDex, usdcAmount);
        assetOut = ISpotDex(spotDex).swapExactIn(usdc, asset, usdcAmount, effective, address(this));
        if (assetOut < effective) revert SlippageExceeded();
        emit ProtocolInteraction(ProtocolActionCodes.DEX_SWAP_FROM_USDC, asset, assetOut);
    }

    function _floor(address spotDex, address tokenIn, address tokenOut, uint256 amountIn, uint256 maxSlippageBps)
        private
        view
        returns (uint256)
    {
        uint256 expectedOut = ISpotDex(spotDex).quoteExactIn(tokenIn, tokenOut, amountIn);
        return expectedOut * (10_000 - maxSlippageBps) / 10_000;
    }

    event ProtocolInteraction(uint8 indexed action, address indexed asset, uint256 amount);
}
