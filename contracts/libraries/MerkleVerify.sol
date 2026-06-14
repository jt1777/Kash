// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

/// @notice Minimal sorted-pair Merkle proof verification (matches OpenZeppelin MerkleProof).
library MerkleVerify {
    function verify(bytes32[] memory proof, bytes32 root, bytes32 leaf) internal pure returns (bool) {
        bytes32 computed = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 p = proof[i];
            computed = computed <= p
                ? keccak256(abi.encodePacked(computed, p))
                : keccak256(abi.encodePacked(p, computed));
        }
        return computed == root;
    }
}
