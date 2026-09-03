// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "./KashVault.sol";

contract KashVaultBtc is KashVault {
    constructor(Init memory i) KashVault("KASH-BTC", "KASH-BTC", i) {}

    function getBtcPrice() external view returns (uint256) {
        return getAssetPrice();
    }
}
