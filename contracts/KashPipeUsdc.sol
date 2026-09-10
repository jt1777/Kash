// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "./KashPipe.sol";

/// @notice Production USDC Pipe. One instance per vault (ETH and BTC).
contract KashPipeUsdc is KashPipe {
    /// @dev Native USDC on Arbitrum One (6 decimals). Not USDC.e.
    address private constant USDC = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831;

    constructor(address vault_, address assetToken_, address spotDex_, uint256 maxSlippageBps_)
        KashPipe(vault_, USDC, assetToken_, spotDex_, maxSlippageBps_)
    {}
}
