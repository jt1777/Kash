// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockWETH - WETH9-compatible mock for testnet
/// @dev Supports deposit() to wrap ETH and withdraw() to unwrap ETH
contract MockWETH is ERC20 {
    event Deposit(address indexed dst, uint256 wad);
    event Withdrawal(address indexed src, uint256 wad);

    constructor() ERC20("Wrapped Ether", "WETH") {}

    /// @dev Wrap ETH: receive ETH and mint equivalent WETH
    receive() external payable {
        deposit();
    }

    /// @dev Wrap ETH: explicit deposit()
    function deposit() public payable {
        _mint(msg.sender, msg.value);
        emit Deposit(msg.sender, msg.value);
    }

    /// @dev Unwrap WETH: burn WETH and return ETH
    function withdraw(uint256 wad) public {
        require(balanceOf(msg.sender) >= wad, "MockWETH: insufficient balance");
        _burn(msg.sender, wad);
        payable(msg.sender).transfer(wad);
        emit Withdrawal(msg.sender, wad);
    }
}
