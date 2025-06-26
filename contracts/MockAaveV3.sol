// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import '@openzeppelin/contracts/token/ERC20/IERC20.sol';

// Custom interface extending IERC20 to include mint for mock purposes
interface IERC20Mintable is IERC20 {
    function mint(address to, uint256 value) external;
}

/**
 * @title MockAaveV3
 * @dev A mock contract to simulate Aave V3 Pool interactions for testing purposes.
 * Supports supply (deposit) and withdraw of ETH, getATokenBalance, and borrow of USDT.
 */
contract MockAaveV3 {
    // Mapping to track how much each address has supplied (deposited) to the pool
    mapping(address => uint256) public suppliedAmounts;
    // Mapping to track how much each address has borrowed from the pool (in USDT)
    mapping(address => uint256) public borrowedAmounts;
    // Total ETH supplied to the pool
    uint256 public totalSupplied;
    // Address of the mock USDT contract for borrowing
    address public usdtAddress;
    // Loan-to-Value ratio for borrowing (e.g., 50% means can borrow up to 50% of collateral value in USD)
    uint256 public constant LTV_RATIO = 50; // 50%
    // Mock ETH price in USD (assuming 18 decimals for simplicity in calculations)
    uint256 public ethPriceInUsd = 2000 * 10**18; // $2,000 per ETH

    constructor(address _usdtAddress) {
        usdtAddress = _usdtAddress;
    }

    // Simulate supplying assets to Aave (for ETH, asset is address(0))
    function supply(address asset, uint256 amount, address onBehalfOf) external payable {
        require(asset == address(0), "Mock only supports ETH supply");
        require(msg.value == amount, "Incorrect ETH amount sent");
        suppliedAmounts[onBehalfOf] += amount;
        totalSupplied += amount;
    }

    // Simulate withdrawing assets from Aave
    function withdraw(address asset, uint256 amount, address to) external returns (uint256) {
        require(asset == address(0), "Mock only supports ETH withdraw");
        require(suppliedAmounts[msg.sender] >= amount, "Insufficient balance to withdraw");
        suppliedAmounts[msg.sender] -= amount;
        totalSupplied -= amount;
        payable(to).transfer(amount);
        return amount;
    }

    // Simulate borrowing USDT against supplied ETH collateral
    function borrow(address asset, uint256 amount, address onBehalfOf) external {
        require(asset == usdtAddress, 'Mock only supports USDT borrow');
        uint256 collateralValueInUsd = (suppliedAmounts[onBehalfOf] * ethPriceInUsd) / 10**18; // ETH amount * price per ETH
        uint256 maxBorrowInUsd = (collateralValueInUsd * LTV_RATIO) / 100; // Max borrow based on LTV
        uint256 requestedBorrowInUsd = amount / 10**(6); // Assuming USDT has 6 decimals, convert to USD value (1 USDT = $1)
        require(requestedBorrowInUsd <= maxBorrowInUsd, 'Borrow amount exceeds LTV limit');
        borrowedAmounts[onBehalfOf] += amount;
        // Mint USDT to the borrower (simulating Aave providing the borrowed asset)
        IERC20Mintable(usdtAddress).mint(onBehalfOf, amount);
    }

    // Get the aToken balance for a user (for ETH, returns supplied amount as mock aToken balance)
    function getATokenBalance(address asset, address user) external view returns (uint256) {
        require(asset == address(0), "Mock only supports ETH aToken balance");
        return suppliedAmounts[user];
    }

    // Get the supplied amount for a user (for testing purposes)
    function getSuppliedAmount(address user) external view returns (uint256) {
        return suppliedAmounts[user];
    }

    // Get the borrowed amount for a user (for testing purposes)
    function getBorrowedAmount(address user) external view returns (uint256) {
        return borrowedAmounts[user];
    }

    // Function to update ETH price for testing flexibility
    function setEthPrice(uint256 _newPrice) external {
        ethPriceInUsd = _newPrice;
    }

    // Allow receiving ETH
    receive() external payable {}
} 