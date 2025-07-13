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
 * Supports supply (deposit) and withdraw of ETH, getATokenBalance, borrow and repay of USDT with interest, and health monitoring.
 */
contract MockAaveV3 {
    // Mapping to track how much each address has supplied (deposited) to the pool
    mapping(address => uint256) public suppliedAmounts;
    // Mapping to track how much each address has borrowed from the pool (in USDT)
    mapping(address => uint256) public borrowedAmounts;
    // Total ETH supplied to the pool
    uint256 public totalSupplied;
    // Total USDT borrowed from the pool
    uint256 public totalBorrowed;
    // Address of the mock USDT contract for borrowing
    address public usdtAddress;
    // Loan-to-Value ratio for borrowing (e.g., 50% means can borrow up to 50% of collateral value in USD)
    uint256 public constant LTV_RATIO = 75; // 75%
    // Liquidation threshold for health factor calculation
    uint256 public constant LIQUIDATION_THRESHOLD = 80; // 80%
    // Mock ETH price in USD (assuming 18 decimals for simplicity in calculations)
    uint256 public ethPriceInUsd = 2000 * 10**18; // $2,000 per ETH
    // Interest rate per second for USDT borrowing (approx 10% annual rate)
    uint256 public interestRatePerSecond = 3170979; // 10% per year / 31536000 seconds
    // Mapping to track the last time interest was updated for a user
    mapping(address => uint256) public lastInterestUpdate;

    event DebugLog(string message, uint256 value);
    event SupplyOperation(address indexed user, address indexed asset, uint256 amount);
    event BorrowOperation(address indexed user, address indexed asset, uint256 amount);
    event RepayOperation(address indexed user, address indexed asset, uint256 amount);

    constructor(address _usdtAddress) {
        usdtAddress = _usdtAddress;
    }

    // Function to set or update the USDT address (for testing flexibility)
    function setUsdtAddress(address _usdtAddress) external {
        usdtAddress = _usdtAddress;
    }

    // Simulate supplying assets to Aave (for ETH, asset is address(0))
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 _referralCode) external payable {
        require(asset == address(0), "Mock only supports ETH supply");
        require(msg.value == amount, "Incorrect ETH amount sent");
        suppliedAmounts[onBehalfOf] += amount;
        totalSupplied += amount;
        emit SupplyOperation(onBehalfOf, asset, amount);
        emit DebugLog("ETH supplied", amount);
        // Reference _referralCode in a no-op to silence unused parameter warning
        if (_referralCode == 0) {
            // No action needed, just a reference to suppress warning
        }
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
    function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 _referralCode, address onBehalfOf) external {
        require(asset == usdtAddress, "Mock only supports USDT borrow");
        require(interestRateMode == 2, "Only variable rate supported");
        // Update interest before borrowing
        updateInterest(onBehalfOf);
        uint256 collateralValueInUsd = (suppliedAmounts[onBehalfOf] * ethPriceInUsd) / 10**18; // ETH amount * price per ETH
        uint256 maxBorrowInUsd = (collateralValueInUsd * LTV_RATIO) / 100; // Max borrow based on LTV
        uint256 currentDebtInUsd = (borrowedAmounts[onBehalfOf] * 10**12); // Assuming USDT has 6 decimals, convert to 18 decimals
        uint256 requestedBorrowInUsd = (amount * 10**12); // Convert requested amount to 18 decimals
        require(currentDebtInUsd + requestedBorrowInUsd <= maxBorrowInUsd, "Borrow amount exceeds LTV limit");
        borrowedAmounts[onBehalfOf] += amount;
        totalBorrowed += amount;
        // Transfer pre-minted USDT to the borrower instead of minting (simulating Aave providing the borrowed asset)
        IERC20(usdtAddress).transfer(onBehalfOf, amount);
        emit BorrowOperation(onBehalfOf, asset, amount);
        emit DebugLog("USDT borrowed", amount);
        // Reference _referralCode in a no-op to silence unused parameter warning
        if (_referralCode == 0) {
            // No action needed, just a reference to suppress warning
        }
    }

    // Simulate repaying USDT debt
    function repay(address asset, uint256 amount, uint256 rateMode, address onBehalfOf) external returns (uint256) {
        require(asset == usdtAddress, "Mock only supports USDT repay");
        require(rateMode == 2, "Only variable rate supported");
        require(borrowedAmounts[onBehalfOf] >= amount, "Repayment exceeds debt");
        // Update interest before repayment
        updateInterest(onBehalfOf);
        borrowedAmounts[onBehalfOf] -= amount;
        totalBorrowed -= amount;
        IERC20(usdtAddress).transferFrom(msg.sender, address(this), amount);
        emit RepayOperation(onBehalfOf, asset, amount);
        emit DebugLog("USDT repaid", amount);
        return amount;
    }

    // Get the aToken balance for a user (for ETH, returns supplied amount as mock aToken balance)
    function getATokenBalance(address asset, address user) external view returns (uint256) {
        require(asset == address(0), "Mock only supports ETH aToken balance");
        return suppliedAmounts[user];
    }

    // Get user account data for health monitoring
    function getUserAccountData(address user) external view returns (
        uint256 totalCollateralETH,
        uint256 totalDebtETH,
        uint256 availableBorrowsETH,
        uint256 currentLiquidationThreshold,
        uint256 ltv,
        uint256 healthFactor
    ) {
        totalCollateralETH = suppliedAmounts[user];
        // Convert USDT debt (6 decimals) to ETH equivalent using current price
        uint256 debtInUsd = borrowedAmounts[user] * 10**12; // Convert to 18 decimals
        totalDebtETH = debtInUsd > 0 ? (debtInUsd * 10**18) / ethPriceInUsd : 0;
        // Calculate available borrows based on LTV
        uint256 collateralValueUsd = (totalCollateralETH * ethPriceInUsd) / 10**18;
        uint256 maxBorrowUsd = (collateralValueUsd * LTV_RATIO) / 100;
        availableBorrowsETH = (maxBorrowUsd > debtInUsd) ? ((maxBorrowUsd - debtInUsd) * 10**18) / ethPriceInUsd : 0;
        currentLiquidationThreshold = LIQUIDATION_THRESHOLD;
        ltv = LTV_RATIO;
        // Calculate health factor (simplified: collateral value * liquidation threshold / debt)
        uint256 liquidationValueUsd = (collateralValueUsd * LIQUIDATION_THRESHOLD) / 100;
        healthFactor = debtInUsd > 0 ? (liquidationValueUsd * 10**18) / debtInUsd : type(uint256).max;
    }

    // Helper function to update interest on USDT debt
    function updateInterest(address user) internal {
        if (borrowedAmounts[user] > 0 && lastInterestUpdate[user] > 0) {
            uint256 timeElapsed = block.timestamp - lastInterestUpdate[user];
            uint256 interest = (borrowedAmounts[user] * interestRatePerSecond * timeElapsed) / 10**18;
            borrowedAmounts[user] += interest;
            totalBorrowed += interest;
        }
        lastInterestUpdate[user] = block.timestamp;
    }

    // Get the supplied amount for a user (for testing purposes)
    function getSuppliedAmount(address user) external view returns (uint256) {
        return suppliedAmounts[user];
    }

    // Get the borrowed amount for a user (for testing purposes)
    function getBorrowedAmount(address user) external view returns (uint256) {
        return borrowedAmounts[user];
    }

    // Get the user's ETH balance (supplied amount) for testing purposes
    function getUserEthBalance(address user) external view returns (uint256) {
        return suppliedAmounts[user];
    }

    // Get the user's USDT debt for testing purposes
    function getUserUsdtDebt(address user) external view returns (uint256) {
        return borrowedAmounts[user];
    }

    // Function to update ETH price for testing flexibility
    function setEthPrice(uint256 _newPrice) external {
        ethPriceInUsd = _newPrice;
    }

    // Function to update interest rate for testing flexibility
    function setInterestRatePerSecond(uint256 _newRate) external {
        interestRatePerSecond = _newRate;
    }

    // Allow receiving ETH
    receive() external payable {}
} 