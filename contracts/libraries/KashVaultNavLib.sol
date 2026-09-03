// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";
import "../ExchangeFacade.sol";
import "../interfaces/IAster.sol";

error InvalidPrice();
error StalePrice();
error InvalidNAV();
error NAVDeviationTooLarge();

library KashVaultNavLib {
    function assetPrice(address oracle, uint256 maxStaleness) external view returns (uint256) {
        (uint80 roundId, int256 price,, uint256 updatedAt, uint80 answeredInRound) =
            AggregatorV3Interface(oracle).latestRoundData();
        if (price <= 0) revert InvalidPrice();
        if (updatedAt == 0 || block.timestamp - updatedAt > maxStaleness) revert StalePrice();
        if (answeredInRound < roundId) revert StalePrice();
        uint8 dec = AggregatorV3Interface(oracle).decimals();
        return uint256(price) * 10 ** (18 - dec);
    }

    function checkNavCaps(uint256 newNAV, uint256 oldNAV, uint256 anchor, uint256 maxBps) external pure {
        if (newNAV == 0) revert InvalidNAV();
        if (oldNAV != 0) {
            uint256 lower = oldNAV * (10_000 - maxBps) / 10_000;
            uint256 upper = oldNAV * (10_000 + maxBps) / 10_000;
            if (newNAV < lower || newNAV > upper) revert NAVDeviationTooLarge();
        }
        if (anchor != 0) {
            uint256 cumLower = anchor * (10_000 - maxBps) / 10_000;
            uint256 cumUpper = anchor * (10_000 + maxBps) / 10_000;
            if (newNAV < cumLower || newNAV > cumUpper) revert NAVDeviationTooLarge();
        }
    }

    function portfolioUsd(
        address assetToken,
        address usdc,
        address aToken,
        address debtToken,
        address clearingHouse,
        address facade,
        uint256 price,
        uint8 assetDecimals,
        uint256 lockedClaimAsset,
        uint256 pendingDepositAssets,
        bool includePendingMint
    ) external view returns (uint256) {
        uint256 idle = IERC20(assetToken).balanceOf(address(this));
        if (idle > lockedClaimAsset) idle -= lockedClaimAsset;
        else idle = 0;
        uint256 aaveCollateral = aToken == address(0) ? 0 : IERC20(aToken).balanceOf(address(this));
        uint256 totalAsset = idle + aaveCollateral;
        if (!includePendingMint) {
            if (totalAsset > pendingDepositAssets) totalAsset -= pendingDepositAssets;
            else totalAsset = 0;
        }
        uint256 assetUsd = (totalAsset * price) / (10 ** uint256(assetDecimals));
        uint256 usdcUsd18 = IERC20(usdc).balanceOf(address(this)) * 1e12;
        uint256 debtUsd18 = debtToken == address(0) ? 0 : IERC20(debtToken).balanceOf(address(this)) * 1e12;
        uint256 asterUsd18 = 0;
        if (clearingHouse != address(0)) {
            address trader = ExchangeFacade(facade).perpExchangeAddress();
            int256 v = IAsterClearingHouse(clearingHouse).getAccountValue(trader);
            if (v > 0) asterUsd18 = uint256(v);
        }
        uint256 credit = assetUsd + usdcUsd18 + asterUsd18;
        if (credit > debtUsd18) return credit - debtUsd18;
        return 0;
    }
}
