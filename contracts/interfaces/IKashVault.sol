// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

/// @dev Minimal vault surface used by KashPipe. Vault contracts are not edited.
interface IKashVault {
    function asset() external view returns (address);

    function requestDeposit(uint256 assets, address controller, address owner_)
        external
        returns (uint256 requestId);

    function requestRedeem(uint256 shares, address controller, address owner_)
        external
        returns (uint256 requestId);

    function redeem(uint256 shares, address receiver, address controller) external returns (uint256 assets);
}
