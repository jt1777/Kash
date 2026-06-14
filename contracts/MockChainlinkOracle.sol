// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

contract MockChainlinkOracle {
    int256 private answer;
    uint8 private immutable answerDecimals;

    constructor(int256 _answer, uint8 _decimals) {
        answer = _answer;
        answerDecimals = _decimals;
    }

    function setAnswer(int256 _answer) external {
        answer = _answer;
    }

    function decimals() external view returns (uint8) {
        return answerDecimals;
    }

    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer_,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        )
    {
        return (1, answer, block.timestamp, block.timestamp, 1);
    }
}
