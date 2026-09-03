// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

/// @dev ExchangeFacade reads the live bot from the vault so `setBotAddress` rotates both.
interface IVaultBot {
    function botAddress() external view returns (address);
}
