// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import '@openzeppelin/contracts/token/ERC20/ERC20.sol';
import '@openzeppelin/contracts/access/Ownable.sol';

/**
 * @title MockUSDC
 * @dev Mock USDC token for testing (6 decimals like real USDC)
 */
contract MockUSDC is ERC20, Ownable {
    uint8 private constant DECIMALS = 6;
    
    constructor() ERC20('USD Coin', 'USDC') Ownable(msg.sender) {
        // Mint initial supply to deployer
        _mint(msg.sender, 1000000 * 10**DECIMALS); // 1M USDC
    }
    
    function decimals() public pure override returns (uint8) {
        return DECIMALS;
    }
    
    /**
     * @dev Mint tokens (for testing)
     */
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
    
    /**
     * @dev Burn tokens (for testing)
     */
    function burn(address from, uint256 amount) external onlyOwner {
        _burn(from, amount);
    }
}
