// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

/// @dev Test mock for Aster Clearing House `getAccountValue` (18-dec USD).
contract MockAsterClearingHouse {
    mapping(address => int256) public accountValue;

    function setAccountValue(address trader, int256 value) external {
        accountValue[trader] = value;
    }

    function getAccountValue(address trader) external view returns (int256) {
        return accountValue[trader];
    }
}
