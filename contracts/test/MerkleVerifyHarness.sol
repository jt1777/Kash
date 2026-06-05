// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "../libraries/MerkleVerify.sol";

contract MerkleVerifyHarness {
    function verify(bytes32[] memory proof, bytes32 root, bytes32 leaf) external pure returns (bool) {
        return MerkleVerify.verify(proof, root, leaf);
    }
}
