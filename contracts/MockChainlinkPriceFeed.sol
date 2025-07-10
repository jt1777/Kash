// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title MockChainlinkPriceFeed
 * @dev A mock contract to simulate Chainlink price feeds for testing purposes.
 * Returns ETH/USD prices (8 decimals, as per Chainlink standard) with a history of prices.
 */
contract MockChainlinkPriceFeed {
    uint8 public constant decimals = 8;

    // Struct to store price data with round ID and timestamp
    struct PriceData {
        int256 price;
        uint256 timestamp;
        uint80 roundId;
    }

    // Array to store historical price data
    PriceData[] public priceHistory;

    // Counter for round IDs
    uint80 private currentRoundId = 0;

    constructor(int256 _initialPrice) {
        // Initialize with a starting price
        priceHistory.push(PriceData(_initialPrice, block.timestamp, currentRoundId));
        currentRoundId++;
    }

    // Mimics Chainlink's latestRoundData function, returning the most recent price
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
        require(priceHistory.length > 0, "No price data available");
        PriceData memory latestPrice = priceHistory[priceHistory.length - 1];
        return (
            latestPrice.roundId,
            latestPrice.price,
            latestPrice.timestamp,
            latestPrice.timestamp,
            latestPrice.roundId
        );
    }

    // Function to update price for testing flexibility
    function setPrice(int256 _newPrice) external {
        priceHistory.push(PriceData(_newPrice, block.timestamp, currentRoundId));
        currentRoundId++;
    }

    // Function to set multiple prices at once for simulating price history
    function setMultiplePrices(int256[] calldata _prices, uint256[] calldata _timestamps) external {
        require(_prices.length == _timestamps.length, "Arrays must have equal length");
        for (uint256 i = 0; i < _prices.length; i++) {
            priceHistory.push(PriceData(_prices[i], _timestamps[i], currentRoundId));
            currentRoundId++;
        }
    }

    // Function to get historical price by round ID
    function getHistoricalPrice(uint80 _roundId)
        external
        view
        returns (int256 price, uint256 timestamp)
    {
        require(_roundId < currentRoundId, "Round ID does not exist");
        for (uint256 i = 0; i < priceHistory.length; i++) {
            if (priceHistory[i].roundId == _roundId) {
                return (priceHistory[i].price, priceHistory[i].timestamp);
            }
        }
        revert("Price for round ID not found");
    }

    // Function to get the total number of price entries
    function getPriceHistoryLength() external view returns (uint256) {
        return priceHistory.length;
    }
} 