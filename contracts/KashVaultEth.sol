// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./KashVault.sol";

interface IWETH9 is IERC20 {
    function deposit() external payable;
}

contract KashVaultEth is KashVault {
    constructor(Init memory i) KashVault("KASH-ETH", "KASH-ETH", i) {}

    function getEthPrice() external view returns (uint256) {
        return getAssetPrice();
    }

    /// @notice Wrap `msg.value` to WETH and request a deposit. `asset()` remains WETH.
    function requestDepositETH(address controller)
        external
        payable
        whenNotPaused
        onlyUserWindow
        nonReentrant
        returns (uint256 requestId)
    {
        if (msg.value == 0) revert ZeroAmount();
        if (controller == address(0)) revert InvalidAddress();
        uint256 cycle = getCurrentBatchCycle();
        if (batchPhase[cycle] != 0) revert WrongPhase();
        if (batchProcessed[cycle]) revert AlreadyProcessed();
        IWETH9(assetToken).deposit{value: msg.value}();
        _addPendingDeposit(cycle, controller, msg.value);
        emit DepositRequest(controller, msg.sender, cycle, msg.sender, msg.value);
        return cycle;
    }
}
