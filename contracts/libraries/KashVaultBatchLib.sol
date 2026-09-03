// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

error EmptyClaimSet();

library KashVaultBatchLib {
    using EnumerableSet for EnumerableSet.UintSet;

    uint256 internal constant BPS_DENOM = 10_000;

    function lockRedeems(
        address[] memory redeemers,
        mapping(uint256 => mapping(address => uint256)) storage pending,
        mapping(uint256 => mapping(address => uint256)) storage claimableShares,
        mapping(uint256 => mapping(address => uint256)) storage claimableAssets,
        mapping(address => EnumerableSet.UintSet) storage cycles,
        uint256 cycle,
        uint256 totalShares,
        uint256 totalGross,
        uint256 feeBps
    ) external returns (uint256 totalNet, uint256 totalFee) {
        if (totalShares == 0 || totalGross == 0) return (0, 0);
        uint256 sharesLeft = totalShares;
        uint256 grossLeft = totalGross;
        for (uint256 i = 0; i < redeemers.length; i++) {
            address u = redeemers[i];
            uint256 reqShares = pending[cycle][u];
            if (reqShares == 0) continue;
            uint256 gross = sharesLeft == reqShares ? grossLeft : (totalGross * reqShares) / totalShares;
            sharesLeft -= reqShares;
            grossLeft -= gross;
            uint256 fee = gross * feeBps / BPS_DENOM;
            uint256 net = gross - fee;
            pending[cycle][u] = 0;
            claimableShares[cycle][u] = reqShares;
            claimableAssets[cycle][u] = net;
            cycles[u].add(cycle);
            totalNet += net;
            totalFee += fee;
        }
    }

    function lockMints(
        address[] memory minters,
        mapping(uint256 => mapping(address => uint256)) storage pending,
        mapping(uint256 => mapping(address => uint256)) storage claimableAssets,
        mapping(uint256 => mapping(address => uint256)) storage claimableShares,
        mapping(address => EnumerableSet.UintSet) storage cycles,
        uint256 cycle,
        uint256 totalShares,
        uint256 totalAsset
    ) external {
        if (totalShares == 0 || totalAsset == 0) return;
        uint256 sharesLeft = totalShares;
        uint256 assetLeft = totalAsset;
        for (uint256 i = 0; i < minters.length; i++) {
            address u = minters[i];
            uint256 reqAsset = pending[cycle][u];
            if (reqAsset == 0) continue;
            uint256 sharesAmt = assetLeft == reqAsset ? sharesLeft : (totalShares * reqAsset) / totalAsset;
            assetLeft -= reqAsset;
            sharesLeft -= sharesAmt;
            pending[cycle][u] = 0;
            claimableAssets[cycle][u] = reqAsset;
            claimableShares[cycle][u] = sharesAmt;
            cycles[u].add(cycle);
        }
    }

    function convertToShares(
        uint256 assets,
        uint256 supply,
        uint256 totalAssets_,
        uint256 nav,
        uint256 price,
        uint8 assetDecimals,
        uint256 virtualShares,
        uint256 virtualAssets
    ) external pure returns (uint256) {
        if (supply == 0 || totalAssets_ == 0) {
            if (nav == 0 || price == 0) return 0;
            uint256 usd = (assets * price) / (10 ** uint256(assetDecimals));
            return (usd * 1e18) / nav;
        }
        return (assets * (supply + virtualShares)) / (totalAssets_ + virtualAssets);
    }

    function convertToAssets(
        uint256 shares,
        uint256 supply,
        uint256 totalAssets_,
        uint256 nav,
        uint256 price,
        uint8 assetDecimals,
        uint256 virtualShares,
        uint256 virtualAssets
    ) external pure returns (uint256) {
        if (supply == 0 || totalAssets_ == 0) {
            if (nav == 0 || price == 0) return 0;
            uint256 usd = (shares * nav) / 1e18;
            return (usd * (10 ** uint256(assetDecimals))) / price;
        }
        return (shares * (totalAssets_ + virtualAssets)) / (supply + virtualShares);
    }

    function totalAssetsOf(uint256 supply, uint256 nav, uint256 price, uint8 assetDecimals)
        external
        pure
        returns (uint256)
    {
        if (nav == 0 || price == 0) return 0;
        uint256 assets18 = (supply * nav) / price;
        if (assetDecimals >= 18) return assets18;
        return assets18 / (10 ** (18 - assetDecimals));
    }

    function oldestCycle(EnumerableSet.UintSet storage set) external view returns (uint256 oldest) {
        uint256 n = set.length();
        if (n == 0) revert EmptyClaimSet();
        oldest = type(uint256).max;
        for (uint256 i = 0; i < n; i++) {
            uint256 c = set.at(i);
            if (c < oldest) oldest = c;
        }
    }

    function takePair(
        mapping(uint256 => mapping(address => uint256)) storage primary,
        mapping(uint256 => mapping(address => uint256)) storage secondary,
        mapping(address => EnumerableSet.UintSet) storage cycles,
        uint256 cycle,
        address controller,
        uint256 amount,
        bool amountIsPrimary
    ) external returns (uint256 other) {
        uint256 p = primary[cycle][controller];
        uint256 s = secondary[cycle][controller];
        if (amountIsPrimary) {
            other = p == amount ? s : (s * amount) / p;
            primary[cycle][controller] = p - amount;
            secondary[cycle][controller] = s - other;
        } else {
            other = s == amount ? p : (p * amount) / s;
            secondary[cycle][controller] = s - amount;
            primary[cycle][controller] = p - other;
        }
        if (primary[cycle][controller] == 0 && secondary[cycle][controller] == 0) {
            cycles[controller].remove(cycle);
        }
    }
}
