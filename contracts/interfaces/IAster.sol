// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

/// @dev Aster (APX) Clearing House views used for on-chain NAV. Trader = AsterAdapter.
interface IAsterClearingHouse {
    function getAccountValue(address trader) external view returns (int256 accountValue);
}

interface IAsterVault {
    function getBalance(address trader) external view returns (int256 balance);
    function getFreeCollateral(address trader) external view returns (int256 freeCollateral);
}

interface IAsterAccountBalance {
    function getTotalPositionSize(address trader, address baseToken) external view returns (int256);
    function getOpenNotional(address trader, address baseToken) external view returns (int256);
}
