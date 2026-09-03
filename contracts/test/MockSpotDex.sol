// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/ISpotDex.sol";

contract MockSpotDex is ISpotDex {
    using SafeERC20 for IERC20;

    uint256 public quoteOut = 1e6;

    function setQuoteOut(uint256 v) external {
        quoteOut = v;
    }

    function quoteExactIn(address, address, uint256) external view returns (uint256) {
        return quoteOut;
    }

    function swapExactIn(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient
    ) external payable returns (uint256 amountOut) {
        amountOut = quoteOut;
        require(amountOut >= minAmountOut, "MockSpotDex: minOut");
        if (tokenIn != address(0)) {
            IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        }
        if (tokenOut != address(0)) {
            IERC20(tokenOut).safeTransfer(recipient, amountOut);
        } else {
            (bool ok, ) = payable(recipient).call{value: amountOut}("");
            require(ok, "MockSpotDex: eth out");
        }
    }

    receive() external payable {}
}
