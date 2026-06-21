// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "../KashYieldBtc.sol";

/// @dev Fork gas-benchmark helper only — not deployed to production.
/// Registers many minters in one tx (same state as repeated `requestMint` calls).
contract BenchmarkKashYieldBtc is KashYieldBtc {
    constructor(address _botAddress, address _wbtc, address _usdc) KashYieldBtc(_botAddress, _wbtc, _usdc) {}

    function benchmarkEnrollMints(address[] calldata users, uint256 amountEach)
        external
        onlyOwner
        onlyUserWindow
        whenNotPaused
    {
        if (amountEach == 0) revert ZeroAmount();
        uint256 batchCycle = block.timestamp / cycleDurationSeconds;
        if (batchPhase[batchCycle] != 0) revert WrongPhase();
        if (batchProcessed[batchCycle]) revert AlreadyProcessed();

        uint256 btcPrice = getBtcPrice();
        uint256 usdIncrement = (amountEach * btcPrice) / (10 ** WBTC_DECIMALS);

        for (uint256 i = 0; i < users.length; i++) {
            address user = users[i];
            MintRequest storage req = userMintRequests[user][batchCycle];
            bool wasActive = req.amountIn > 0;
            req.user = user;
            req.amountIn += amountEach;
            req.batchCycle = batchCycle;
            req.amountInUSD += usdIncrement;
            batchTotalMintValueUSD[batchCycle] += usdIncrement;
            batchTotalMintBtc[batchCycle] += amountEach;
            if (!wasActive) {
                if (activeMintUsers[batchCycle] >= maxMintUsers) revert MintCapReached();
                unchecked {
                    activeMintUsers[batchCycle]++;
                }
            }
            if (!isInBatchMint[batchCycle][user]) {
                batchMintUsers[batchCycle].push(user);
                isInBatchMint[batchCycle][user] = true;
            }
        }
    }
}
