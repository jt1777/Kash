// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';

// Custom interface extending IERC20 to include mint for mock purposes
interface IERC20Mintable is IERC20 {
    function mint(address to, uint256 value) external;
}

/**
 * @title MockAaveV3
 * @dev A mock contract to simulate Aave V3 Pool interactions for testing purposes.
 * Supports supply/withdraw of ETH and wBTC, borrow and repay of USDC with interest, and health monitoring.
 */
contract MockAaveV3 {
    using SafeERC20 for IERC20;

    // Mapping to track how much each address has supplied (deposited) to the pool
    mapping(address => uint256) public suppliedAmounts;
    // Mapping to track how much each address has supplied in wBTC (8 decimals)
    mapping(address => uint256) public suppliedWbtcAmounts;
    // Mapping to track how much each address has borrowed from the pool (in USDC)
    mapping(address => uint256) public borrowedAmounts;
    // Total ETH supplied to the pool
    uint256 public totalSupplied;
    // Total wBTC supplied to the pool
    uint256 public totalSuppliedWbtc;
    // Total USDC borrowed from the pool
    uint256 public totalBorrowed;
    // Address of the mock USDC contract for borrowing
    address public usdcAddress;
    // Address of wBTC for supply/withdraw (set via setWbtcAddress, optional)
    address public wbtcAddress;
    // Address of WETH for supply/withdraw (set via setWethAddress, optional)
    address public wethAddress;
    // Loan-to-Value ratio for borrowing (e.g., 50% means can borrow up to 50% of collateral value in USD)
    uint256 public constant LTV_RATIO = 75; // 75%
    // Liquidation threshold for health factor calculation
    uint256 public constant LIQUIDATION_THRESHOLD = 80; // 80%
    // Mock ETH price in USD (assuming 18 decimals for simplicity in calculations)
    uint256 public ethPriceInUsd = 2000 * 10**18; // $2,000 per ETH
    // Mock BTC price in USD (18 decimals, per 1e8 wBTC base units)
    uint256 public btcPriceInUsd = 60000 * 10**18; // $60,000 per BTC
    // wBTC has 8 decimals
    uint256 public constant WBTC_DECIMALS = 8;
    // Interest rate per second for USDC borrowing (approx 10% annual rate)
    uint256 public interestRatePerSecond = 3170979; // 10% per year / 31536000 seconds
    // Mapping to track the last time interest was updated for a user
    mapping(address => uint256) public lastInterestUpdate;
    // Mapping to track when each user first supplied ETH (for yield calculation)
    mapping(address => uint256) public firstSupplyTimestamp;
    // Mapping to track when each user first supplied wBTC (for yield calculation)
    mapping(address => uint256) public firstWbtcSupplyTimestamp;
    // Daily yield rate: 0.0001 ETH per day per 1 ETH deposited
    uint256 public constant DAILY_YIELD_RATE = 100000000000000; // 0.0001 ETH in wei
    // Daily yield rate for wBTC: 0.0001 per day per 1 wBTC (8 decimals)
    uint256 public constant DAILY_YIELD_RATE_WBTC = 10000; // 0.0001 * 1e8 in wBTC base units

    event DebugLog(string message, uint256 value);
    event SupplyOperation(address indexed user, address indexed asset, uint256 amount);
    event BorrowOperation(address indexed user, address indexed asset, uint256 amount);
    event RepayOperation(address indexed user, address indexed asset, uint256 amount);

    constructor(address _usdcAddress) {
        usdcAddress = _usdcAddress;
    }

    // Function to set or update the USDC address (for testing flexibility)
    function setUsdcAddress(address _usdcAddress) external {
        usdcAddress = _usdcAddress;
    }

    // Function to set or update the wBTC address (for wBTC supply/withdraw)
    function setWbtcAddress(address _wbtcAddress) external {
        wbtcAddress = _wbtcAddress;
    }

    // Function to set or update the WETH address (for WETH supply/withdraw — ETH product)
    function setWethAddress(address _wethAddress) external {
        wethAddress = _wethAddress;
    }

    // Simulate supplying assets to Aave
    // ETH product: supply(wethAddress, amount, ...) — transfers WETH ERC-20, tracked in suppliedAmounts
    // BTC product: supply(wbtcAddress, amount, ...) — transfers wBTC ERC-20
    // Native ETH:  supply(address(0), amount, ...) — sends ETH via msg.value
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 _referralCode) external payable {
        if (asset == address(0)) {
            require(msg.value == amount, "Incorrect ETH amount sent");
            if (suppliedAmounts[onBehalfOf] == 0) {
                firstSupplyTimestamp[onBehalfOf] = block.timestamp;
            }
            suppliedAmounts[onBehalfOf] += amount;
            totalSupplied += amount;
            emit SupplyOperation(onBehalfOf, asset, amount);
            emit DebugLog("ETH supplied", amount);
        } else if (asset == wethAddress && wethAddress != address(0)) {
            // WETH is 1:1 with ETH — track in the same suppliedAmounts mapping
            require(msg.value == 0, "No ETH expected for WETH supply");
            require(amount > 0, "Amount must be > 0");
            IERC20(wethAddress).safeTransferFrom(msg.sender, address(this), amount);
            if (suppliedAmounts[onBehalfOf] == 0) {
                firstSupplyTimestamp[onBehalfOf] = block.timestamp;
            }
            suppliedAmounts[onBehalfOf] += amount;
            totalSupplied += amount;
            emit SupplyOperation(onBehalfOf, asset, amount);
            emit DebugLog("WETH supplied", amount);
        } else if (asset == wbtcAddress && wbtcAddress != address(0)) {
            require(msg.value == 0, "No ETH expected for wBTC supply");
            require(amount > 0, "Amount must be > 0");
            IERC20(wbtcAddress).safeTransferFrom(msg.sender, address(this), amount);
            if (suppliedWbtcAmounts[onBehalfOf] == 0) {
                firstWbtcSupplyTimestamp[onBehalfOf] = block.timestamp;
            }
            suppliedWbtcAmounts[onBehalfOf] += amount;
            totalSuppliedWbtc += amount;
            emit SupplyOperation(onBehalfOf, asset, amount);
            emit DebugLog("WBTC supplied", amount);
        } else {
            revert("Mock only supports ETH, WETH, or wBTC supply");
        }
        if (_referralCode == 0) { }
    }

    // Simulate withdrawing assets from Aave
    function withdraw(address asset, uint256 amount, address to) external returns (uint256) {
        if (asset == address(0)) {
            require(suppliedAmounts[msg.sender] >= amount, "Insufficient balance to withdraw");
            suppliedAmounts[msg.sender] -= amount;
            totalSupplied -= amount;
            payable(to).transfer(amount);
            return amount;
        } else if (asset == wethAddress && wethAddress != address(0)) {
            // Return WETH ERC-20 to caller (KashYieldETH unwraps it itself)
            require(suppliedAmounts[msg.sender] >= amount, "Insufficient WETH balance to withdraw");
            suppliedAmounts[msg.sender] -= amount;
            totalSupplied -= amount;
            IERC20(wethAddress).safeTransfer(to, amount);
            return amount;
        } else if (asset == wbtcAddress && wbtcAddress != address(0)) {
            require(suppliedWbtcAmounts[msg.sender] >= amount, "Insufficient wBTC balance to withdraw");
            suppliedWbtcAmounts[msg.sender] -= amount;
            totalSuppliedWbtc -= amount;
            IERC20(wbtcAddress).safeTransfer(to, amount);
            return amount;
        } else {
            revert("Mock only supports ETH, WETH, or wBTC withdraw");
        }
    }

    // Simulate borrowing USDC against supplied ETH and/or wBTC collateral
    function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 _referralCode, address onBehalfOf) external {
        require(asset == usdcAddress, "Mock only supports USDC borrow");
        require(interestRateMode == 2, "Only variable rate supported");
        // Update interest before borrowing
        updateInterest(onBehalfOf);
        // Collateral: ETH value + wBTC value (wBTC amount is 8 decimals, btcPriceInUsd is per full BTC)
        uint256 ethCollateralUsd = (suppliedAmounts[onBehalfOf] * ethPriceInUsd) / 10**18;
        uint256 wbtcCollateralUsd = suppliedWbtcAmounts[onBehalfOf] > 0
            ? (suppliedWbtcAmounts[onBehalfOf] * btcPriceInUsd) / (10 ** WBTC_DECIMALS)
            : 0;
        uint256 collateralValueInUsd = ethCollateralUsd + wbtcCollateralUsd;
        uint256 maxBorrowInUsd = (collateralValueInUsd * LTV_RATIO) / 100; // Max borrow based on LTV
        uint256 currentDebtInUsd = (borrowedAmounts[onBehalfOf] * 10**12); // Assuming USDC has 6 decimals, convert to 18 decimals
        uint256 requestedBorrowInUsd = (amount * 10**12); // Convert requested amount to 18 decimals
        require(currentDebtInUsd + requestedBorrowInUsd <= maxBorrowInUsd, "Borrow amount exceeds LTV limit");
        borrowedAmounts[onBehalfOf] += amount;
        totalBorrowed += amount;
        // Transfer pre-minted USDC to the borrower instead of minting (simulating Aave providing the borrowed asset)
        IERC20(usdcAddress).transfer(onBehalfOf, amount);
        emit BorrowOperation(onBehalfOf, asset, amount);
        emit DebugLog("USDC borrowed", amount);
        // Reference _referralCode in a no-op to silence unused parameter warning
        if (_referralCode == 0) {
            // No action needed, just a reference to suppress warning
        }
    }

    // Simulate repaying USDC debt
    function repay(address asset, uint256 amount, uint256 rateMode, address onBehalfOf) external returns (uint256) {
        require(asset == usdcAddress, "Mock only supports USDC repay");
        require(rateMode == 2, "Only variable rate supported");
        require(borrowedAmounts[onBehalfOf] >= amount, "Repayment exceeds debt");
        // Update interest before repayment
        updateInterest(onBehalfOf);
        borrowedAmounts[onBehalfOf] -= amount;
        totalBorrowed -= amount;
        IERC20(usdcAddress).transferFrom(msg.sender, address(this), amount);
        emit RepayOperation(onBehalfOf, asset, amount);
        emit DebugLog("USDC repaid", amount);
        return amount;
    }

    // Get the aToken balance for a user (ETH/WETH or wBTC, returns supplied amount + accrued yield)
    function getATokenBalance(address asset, address user) external view returns (uint256) {
        if (asset == address(0) || (asset == wethAddress && wethAddress != address(0))) {
            // ETH (address(0)) and WETH are both tracked in suppliedAmounts
            uint256 originalAmount = suppliedAmounts[user];
            if (originalAmount == 0 || firstSupplyTimestamp[user] == 0) {
                return originalAmount;
            }
            uint256 timeElapsed = block.timestamp - firstSupplyTimestamp[user];
            uint256 daysElapsed = timeElapsed / 86400;
            uint256 yieldEarned = (originalAmount * DAILY_YIELD_RATE * daysElapsed) / 1e18;
            return originalAmount + yieldEarned;
        } else if (asset == wbtcAddress && wbtcAddress != address(0)) {
            uint256 originalAmount = suppliedWbtcAmounts[user];
            if (originalAmount == 0 || firstWbtcSupplyTimestamp[user] == 0) {
                return originalAmount;
            }
            uint256 timeElapsed = block.timestamp - firstWbtcSupplyTimestamp[user];
            uint256 daysElapsed = timeElapsed / 86400;
            uint256 yieldEarned = (originalAmount * DAILY_YIELD_RATE_WBTC * daysElapsed) / (10 ** WBTC_DECIMALS);
            return originalAmount + yieldEarned;
        } else {
            revert("Mock only supports ETH, WETH, or wBTC aToken balance");
        }
    }

    // Get user account data for health monitoring (collateral includes ETH + wBTC)
    function getUserAccountData(address user) external view returns (
        uint256 totalCollateralETH,
        uint256 totalDebtETH,
        uint256 availableBorrowsETH,
        uint256 currentLiquidationThreshold,
        uint256 ltv,
        uint256 healthFactor
    ) {
        // Total collateral in ETH terms: ETH + (wBTC value / eth price)
        uint256 ethCollateralUsd = (suppliedAmounts[user] * ethPriceInUsd) / 10**18;
        uint256 wbtcCollateralUsd = suppliedWbtcAmounts[user] > 0
            ? (suppliedWbtcAmounts[user] * btcPriceInUsd) / (10 ** WBTC_DECIMALS)
            : 0;
        uint256 collateralValueUsd = ethCollateralUsd + wbtcCollateralUsd;
        totalCollateralETH = ethPriceInUsd > 0 ? (collateralValueUsd * 10**18) / ethPriceInUsd : 0;
        // Convert USDC debt (6 decimals) to ETH equivalent using current price
        uint256 debtInUsd = borrowedAmounts[user] * 10**12;
        totalDebtETH = debtInUsd > 0 ? (debtInUsd * 10**18) / ethPriceInUsd : 0;
        // Calculate available borrows based on LTV
        uint256 maxBorrowUsd = (collateralValueUsd * LTV_RATIO) / 100;
        availableBorrowsETH = (maxBorrowUsd > debtInUsd) ? ((maxBorrowUsd - debtInUsd) * 10**18) / ethPriceInUsd : 0;
        currentLiquidationThreshold = LIQUIDATION_THRESHOLD;
        ltv = LTV_RATIO;
        uint256 liquidationValueUsd = (collateralValueUsd * LIQUIDATION_THRESHOLD) / 100;
        healthFactor = debtInUsd > 0 ? (liquidationValueUsd * 10**18) / debtInUsd : type(uint256).max;
    }

    // Helper function to update interest on USDC debt
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

    /// @notice Accrued supply yield in ETH (18 decimals). For bot: aaveSupplyEarned in USD = this * ethPriceInUsd / 1e18.
    function getAccruedSupplyYieldEth(address user) external view returns (uint256) {
        uint256 aToken = this.getATokenBalance(address(0), user);
        uint256 principal = suppliedAmounts[user];
        return aToken > principal ? aToken - principal : 0;
    }

    /// @notice Estimated borrow interest over one day (86400 seconds) in USD 18 decimals. Uses current debt and interestRatePerSecond.
    function getEstimatedDailyBorrowInterestUsd(address user) external view returns (uint256) {
        if (borrowedAmounts[user] == 0) return 0;
        // interest (USDC 6 dec) = (borrowed * rate * 86400) / 1e18; USD 18 = interest * 1e12
        uint256 interestUsdt6 = (borrowedAmounts[user] * interestRatePerSecond * 86400) / 10**18;
        return interestUsdt6 * 10**12;
    }

    // Get the user's ETH balance (supplied amount) for testing purposes
    function getUserEthBalance(address user) external view returns (uint256) {
        return suppliedAmounts[user];
    }

    // Get the user's USDC debt for testing purposes
    function getUserUsdcDebt(address user) external view returns (uint256) {
        return borrowedAmounts[user];
    }

    // Function to update ETH price for testing flexibility
    function setEthPrice(uint256 _newPrice) external {
        ethPriceInUsd = _newPrice;
    }

    // Function to update BTC price for testing flexibility (18 decimals per full BTC)
    function setBtcPrice(uint256 _newPrice) external {
        btcPriceInUsd = _newPrice;
    }

    // Function to update interest rate for testing flexibility
    function setInterestRatePerSecond(uint256 _newRate) external {
        interestRatePerSecond = _newRate;
    }

    // Get the user's wBTC balance (supplied amount) for testing purposes
    function getUserWbtcBalance(address user) external view returns (uint256) {
        return suppliedWbtcAmounts[user];
    }

    /// @notice Accrued supply yield in wBTC (8 decimals). For bot: aaveSupplyEarned in USD = this * btcPriceInUsd / 1e8.
    function getAccruedSupplyYieldWbtc(address user) external view returns (uint256) {
        if (wbtcAddress == address(0)) return 0;
        uint256 aToken = this.getATokenBalance(wbtcAddress, user);
        uint256 principal = suppliedWbtcAmounts[user];
        return aToken > principal ? aToken - principal : 0;
    }

    // Allow receiving ETH
    receive() external payable {}
} 