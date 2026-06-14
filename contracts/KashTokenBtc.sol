// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import '@openzeppelin/contracts/token/ERC20/ERC20.sol';
import '@openzeppelin/contracts/access/Ownable.sol';

/**
 * @title KashTokenBtc (KASH_BTC)
 * @dev Share token for the wBTC yield product. Mintable/burnable by KashYieldBtc only.
 */
contract KashTokenBtc is ERC20, Ownable {
    constructor() ERC20('Kash BTC', 'KASH_BTC') Ownable(msg.sender) {}

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external onlyOwner {
        _burn(from, amount);
    }
}
