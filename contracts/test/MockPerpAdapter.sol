// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "../interfaces/IPerpExchange.sol";

/// @dev Minimal IPerpExchange for unit tests. NAV reads Clearing House directly, not this.
contract MockPerpAdapter is IPerpExchange {
    function depositCollateral(address, uint256) external override {}
    function withdrawCollateral(address, uint256) external override returns (uint256) { return 0; }
    function tradeSpot(address, address, uint256) external payable override returns (uint256) { return 0; }
    function withdrawAsset(uint256) external override {}
    function openPerpPosition(string calldata, uint256, bool) external override {}
    function closePerpPosition(string calldata) external override {}
    function closePerpPosition(string calldata, uint256) external override {}
    function cancelOrder(bytes32) external override {}
    function getSpotBalance() external pure override returns (uint256) { return 0; }
    function getAssetBalance() external pure override returns (uint256) { return 0; }
    function getPosition(string calldata) external pure override returns (uint256, uint256, uint256, bool, bool) {
        return (0, 0, 0, false, false);
    }
    function getOpenOrderIds() external pure override returns (bytes32[] memory) {
        return new bytes32[](0);
    }
}
