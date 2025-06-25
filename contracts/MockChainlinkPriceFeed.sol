// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title MockChainlinkPriceFeed
 * @dev A mock contract to simulate Chainlink price feeds for testing purposes.
 * Returns a hardcoded ETH/USD price (8 decimals, as per Chainlink standard).
 */
contract MockChainlinkPriceFeed {
    int256 private price;
    uint8 public constant decimals = 8;

    constructor(int256 _initialPrice) {
        price = _initialPrice; // e.g., 200000000000 for $2,000.00 with 8 decimals
    }

    // Mimics Chainlink's latestRoundData function
    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        )
    {
        return (0, price, 0, block.timestamp, 0);
    }

    // Function to update price for testing flexibility
    function setPrice(int256 _newPrice) external {
        price = _newPrice;
    }
} 