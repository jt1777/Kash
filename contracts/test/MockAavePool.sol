// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./MockERC20.sol";

contract MockAavePool {
    using SafeERC20 for IERC20;

    mapping(address => address) public aToken;
    mapping(address => address) public variableDebtToken;

    function setReserve(address asset, address aToken_, address debtToken_) external {
        aToken[asset] = aToken_;
        variableDebtToken[asset] = debtToken_;
    }

    function supply(address asset, uint256 amount, address onBehalfOf, uint16) external {
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        MockERC20(aToken[asset]).mint(onBehalfOf, amount);
    }

    function withdraw(address asset, uint256 amount, address to) external returns (uint256) {
        MockERC20(aToken[asset]).burn(msg.sender, amount);
        IERC20(asset).safeTransfer(to, amount);
        return amount;
    }

    function borrow(address asset, uint256 amount, uint256, uint16, address onBehalfOf) external {
        MockERC20(variableDebtToken[asset]).mint(onBehalfOf, amount);
        IERC20(asset).safeTransfer(onBehalfOf, amount);
    }

    function repay(address asset, uint256 amount, uint256, address onBehalfOf) external returns (uint256) {
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        MockERC20(variableDebtToken[asset]).burn(onBehalfOf, amount);
        return amount;
    }
}
