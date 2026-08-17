// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

contract MockChainlinkOracle {
    int256 private answer;
    uint8 private immutable answerDecimals;
    bool private stale;
    bool private incompleteRound;

    constructor(int256 _answer, uint8 _decimals) {
        answer = _answer;
        answerDecimals = _decimals;
    }

    function setAnswer(int256 _answer) external {
        answer = _answer;
    }

    // FIX-3 test helpers — default to fresh/complete so existing tests are unaffected.
    function setStale(bool _stale) external {
        stale = _stale;
    }

    function setIncompleteRound(bool _incomplete) external {
        incompleteRound = _incomplete;
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
        uint256 t = stale ? block.timestamp - 30 hours : block.timestamp;
        uint80 air = incompleteRound ? 0 : 1;
        return (1, answer, block.timestamp, t, air);
    }
}
