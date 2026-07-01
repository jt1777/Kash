// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "../KashYieldBtc.sol";

/// @dev Fork gas-benchmark helper only — not deployed to production.
contract BenchmarkKashYieldBtc is KashYieldBtc {
    constructor(
        address _botAddress,
        address _wbtc,
        address _usdc,
        address _exchangeFacade,
        address _spotDex,
        address _btcOracle,
        address _keeperRegistry,
        address _feeReceiver,
        uint256 _cycleDurationSeconds,
        uint256 _userWindowEnd,
        uint256 _processingWindowStart,
        uint256 _maxSwapSlippageBps,
        uint256 _feeBps,
        uint256 _maxMintUsers,
        uint256 _maxRedeemUsers
    )
        KashYieldBtc(
            _botAddress,
            _wbtc,
            _usdc,
            _exchangeFacade,
            _spotDex,
            _btcOracle,
            _keeperRegistry,
            _feeReceiver,
            _cycleDurationSeconds,
            _userWindowEnd,
            _processingWindowStart,
            _maxSwapSlippageBps,
            _feeBps,
            _maxMintUsers,
            _maxRedeemUsers
        )
    {}

    function benchmarkEnrollMints(address[] calldata users, uint256 amountEach)
        external
        onlyBotOrKeeper
        onlyUserWindow
    {
        if (amountEach == 0) revert ZeroAmount();
        uint256 batchCycle = block.timestamp / cycleDurationSeconds;
        if (batchPhase[batchCycle] != 0) revert WrongPhase();
        if (batchProcessed[batchCycle]) revert AlreadyProcessed();

        for (uint256 i = 0; i < users.length; i++) {
            address user = users[i];
            MintRequest storage req = userMintRequests[user][batchCycle];
            bool wasActive = req.amountIn > 0;
            req.user = user;
            req.amountIn += amountEach;
            req.batchCycle = batchCycle;
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
