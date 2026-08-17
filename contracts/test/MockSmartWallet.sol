// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

interface IKashYieldETH {
    function requestMint(uint256 amount) external payable;
    function cancelMintRequest(uint256 batchCycle) external;
}

/// Contract wallet whose receive() does a storage write (>2300 gas).
/// Under the old `.transfer` refund this would brick (2300 gas stipend);
/// FIX-6's `.call{value}` forwards full gas so the refund lands.
contract MockSmartWallet {
    bool public refunded;

    function submitMint(address vault) external payable {
        IKashYieldETH(vault).requestMint{value: msg.value}(0);
    }

    function cancelMint(address vault, uint256 cycle) external {
        IKashYieldETH(vault).cancelMintRequest(cycle);
    }

    receive() external payable {
        refunded = true; // SSTORE — needs >2300 gas
    }
}
