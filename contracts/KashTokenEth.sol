// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import '@openzeppelin/contracts/token/ERC20/ERC20.sol';
import '@openzeppelin/contracts/access/Ownable.sol';

/**
 * @title KashTokenEth (KASH_ETH)
 * @dev Share token for the ETH yield product. Mintable/burnable by KashYieldETH only.
 */
contract KashTokenEth is ERC20, Ownable {
    constructor() ERC20('Kash ETH', 'KASH_ETH') Ownable(msg.sender) {}

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external onlyOwner {
        _burn(from, amount);
    }
}
