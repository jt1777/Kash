// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import '@openzeppelin/contracts/token/ERC20/ERC20.sol';
import '@openzeppelin/contracts/access/Ownable.sol';

contract YToken is ERC20, Ownable {
    constructor() ERC20('YToken', 'YTK') Ownable(msg.sender) {
        // Initial supply can be 0 since tokens will be minted as needed
    }

    // Function to mint new tokens, only callable by the owner (AaveYieldLock contract)
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    // Function to burn tokens if needed, only callable by the owner
    function burn(address from, uint256 amount) external onlyOwner {
        _burn(from, amount);
    }
} 