// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "./KashPipe.sol";

/// @notice Production USDT Pipe. Same code as USDC; USDT approve is non-standard (`forceApprove`).
contract KashPipeUsdt is KashPipe {
    /// @dev Official Tether USD on Arbitrum One (6 decimals).
    address private constant USDT = 0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9;

    constructor(address vault_, address assetToken_, address spotDex_, uint256 maxSlippageBps_)
        KashPipe(vault_, USDT, assetToken_, spotDex_, maxSlippageBps_)
    {}
}
