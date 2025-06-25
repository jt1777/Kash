// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

interface IPool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external payable;
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
    function getATokenBalance(address asset, address user) external view returns (uint256);
    function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf) external;
}

interface IChainlinkPriceFeed {
    function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
    function decimals() external view returns (uint8);
}

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IPriceFeed {
    function latestAnswer() external view returns (int256);
}

// Interface for MockGMX to interact with the mock GMX DEX contract
interface IMockGMX {
    function depositCollateralAndOpenPosition(uint256 amount, bool isLong, address onBehalfOf) external;
    function depositCollateralAndOpenPositionWithSize(uint256 amount, uint256 positionSize, bool isLong, address onBehalfOf) external;
}

/**
 * @title AaveYieldLock
 * @dev A contract that locks user funds until a daily bulk transfer to Aave V3 at 12:00 AM HKT.
 * Deposits after 4:00 PM HKT are eligible for the next day's cycle. aTokens are held by the contract,
 * and user shares are tracked internally. Users cannot withdraw aTokens directly.
 * After bulk deposit, borrows 40% of ETH value in USDT.
 * Includes configurable parameters for testing and design purposes.
 */
contract AaveYieldLock {
    address payable public owner;
    address public aavePoolAddress;
    address public priceFeedAddress;
    address public usdtAddress;
    address public gmxAddress;
    
    // Mapping to track balances of individual depositors before transfer to Aave
    mapping(address => uint) public balancesBeforeTransfer;
    // Mapping to track the cycle (day) when the user's deposit is eligible for bulk transfer
    mapping(address => uint) public eligibleCycleDay;
    // Total aToken balance held by the contract for ETH deposits
    uint public totalATokenBalance;
    // Total amount deposited to Aave by the contract
    uint256 public totalAmountInAave;
    // Total USDT borrowed by the contract
    uint public totalBorrowedUSDT;
    // Timestamp of the last bulk transfer to Aave
    uint public lastBulkTransferTime;
    // Total ETH deposited by users but not yet transferred to Aave
    uint256 public pendingDepositBalance;
    
    // Configuration variables for design and testing
    uint public depositsPerDay = 1; // Number of bulk deposits to Aave per day (default: 1)
    uint256 public usdtBorrowPercentage = 40; // Percentage of ETH value to borrow as USDT (default: 40%)

    // Mapping to track individual user deposits to Aave (if not already present)
    mapping(address => uint256) public userDepositedToAave; // Tracks per user ETH deposited to Aave
    uint256 public totalEthDepositedToAave; // Total ETH deposited to Aave across all users

    // Add variables to track user contributions per batch cycle
    mapping(address => mapping(uint256 => uint256)) public userBatchContributions; // Tracks user ETH contributions per batch cycle (eligibleCycleDay)
    // Optionally, track total ETH per batch cycle if needed
    mapping(uint256 => uint256) public totalBatchContributions; // Tracks total ETH for each batch cycle

    // Add variables to track USD value of ETH shorted
    uint256 public totalUsdValueShorted; // Total USD value of ETH shorted on GMX, in 18 decimals
    mapping(address => uint256) public userUsdValueShorted; // USD value of ETH shorted per user, in 18 decimals

    event Deposit(address indexed user, uint256 amount, uint256 timestamp);
    event BulkDepositToAave(uint256 amount, uint256 timestamp);
    event USDTBorrowed(uint256 usdtAmount, uint256 timestamp);
    event ConfigurationUpdated(uint256 depositsPerDay, uint256 cutoffHourHKT, uint256 cutoffMinuteHKT, uint256 borrowPercentage);
    event USDTTransferredToGMX(uint256 amount);

    constructor(
        address _aavePoolAddress,
        address _usdtAddress,
        address _priceFeedAddress,
        address _gmxAddress
    ) payable {
        owner = payable(msg.sender);
        aavePoolAddress = _aavePoolAddress;
        usdtAddress = _usdtAddress;
        priceFeedAddress = _priceFeedAddress;
        gmxAddress = _gmxAddress;
        balancesBeforeTransfer[msg.sender] = msg.value;
        
        emit Deposit(msg.sender, msg.value, block.timestamp);
    }

    // Modifier to restrict functions to contract owner
    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner can call this function");
        _;
    }

    // Function to update configuration parameters (only callable by owner)
    function updateConfiguration(uint _depositsPerDay, uint _cutoffHourHKT, uint _borrowPercentage) external onlyOwner {
        require(_depositsPerDay > 0, "Deposits per day must be greater than 0");
        require(_cutoffHourHKT < 24, "Cutoff hour must be between 0 and 23");
        require(_borrowPercentage <= 100, "Borrow percentage must be between 0 and 100");
        depositsPerDay = _depositsPerDay;
        usdtBorrowPercentage = _borrowPercentage;
        emit ConfigurationUpdated(_depositsPerDay, _cutoffHourHKT, 0, _borrowPercentage);
    }

    // Function for anyone to deposit funds
    function deposit() external payable {
        require(msg.value > 0, "Deposit amount must be greater than 0");
        balancesBeforeTransfer[msg.sender] += msg.value;
        pendingDepositBalance += msg.value;
        uint256 batchTime = getEligibleBatchTime();
        eligibleCycleDay[msg.sender] = batchTime;
        // Track user's contribution to this batch cycle
        userBatchContributions[msg.sender][batchTime] += msg.value;
        totalBatchContributions[batchTime] += msg.value;
        emit Deposit(msg.sender, msg.value, block.timestamp);
    }

    // Function to check if current time is within the deposit window for bulk transfer to Aave
    function isWithinDepositWindow() public view returns (bool) {
        uint256 TIME_OFFSET = 30 * 60; // 30 minutes offset instead of HKT 8 hours
        uint256 SECONDS_PER_DAY = 86400;
        uint256 currentTimeAdjusted = (block.timestamp + TIME_OFFSET) % SECONDS_PER_DAY;
        // uint256 currentDayStart = block.timestamp - currentTimeAdjusted;
        // Define window as 11:30:01 PM Day 1 to 11:30:00 PM Day 2 relative to adjusted time
        // 11:30 PM is 23:30, which is (23 * 3600 + 30 * 60) seconds
        uint256 windowStartTimeOfDay = (23 * 3600) + (30 * 60) + 1; // 11:30:01 PM
        uint256 windowEndTimeOfDay = (23 * 3600) + (30 * 60); // 11:30:00 PM
        // Check if current time falls within the window (considering it spans across days)
        if (currentTimeAdjusted >= windowStartTimeOfDay || currentTimeAdjusted <= windowEndTimeOfDay) {
            return true; // Within the deposit window
        }
        return false; // Outside the window
    }

    // Function to determine the eligible batch time for Aave deposit (12:00 AM Day 3 for deposits in the window)
    function getEligibleBatchTime() public view returns (uint256) {
        uint256 TIME_OFFSET = 30 * 60; // 30 minutes offset
        uint256 SECONDS_PER_DAY = 86400;
        uint256 currentTimeAdjusted = (block.timestamp + TIME_OFFSET) % SECONDS_PER_DAY;
        uint256 currentDayStart = block.timestamp - currentTimeAdjusted;
        // If within window (11:30:01 PM Day 1 to 11:30:00 PM Day 2), batch at 12:00 AM Day 3
        uint256 windowEndTimeOfDay = (23 * 3600) + (30 * 60); // 11:30:00 PM
        if (currentTimeAdjusted <= windowEndTimeOfDay || currentTimeAdjusted >= ((23 * 3600) + (30 * 60) + 1)) {
            // Deposits in this window are eligible for batching at 12:00 AM of the day after tomorrow (Day 3)
            return currentDayStart + (2 * SECONDS_PER_DAY); // 12:00 AM Day 3
        }
        // Otherwise, next window's batch time (this logic can be adjusted if needed)
        return currentDayStart + (3 * SECONDS_PER_DAY); // Next possible batch
    }

    // Function for bulk transfer to Aave, callable by a bot, with immediate USDT borrow
    function bulkDepositToAave() external {
        require(isWithinDepositWindow(), "Not within deposit window");
        uint256 totalPending = pendingDepositBalance;
        require(totalPending > 0, "No pending deposits to transfer");
        
        // Deposit ETH to Aave and receive aTokens
        IPool(aavePoolAddress).supply{value: totalPending}(address(0), totalPending, address(this), 0);
        pendingDepositBalance = 0;
        totalEthDepositedToAave += totalPending;
        emit BulkDepositToAave(totalPending, block.timestamp);
        
        // Borrow USDT based on the deposited ETH value
        uint256 ethPrice = getLatestEthPrice();
        uint256 ethValueInUsd = (totalPending * ethPrice) / 1e18;
        uint256 usdtToBorrow = (ethValueInUsd * usdtBorrowPercentage * 1e6) / (100 * 1e18); // USDT has 6 decimals
        if (usdtToBorrow > 0) {
            IPool(aavePoolAddress).borrow(usdtAddress, usdtToBorrow, 2, 0, address(this));
            totalBorrowedUSDT += usdtToBorrow;
            emit USDTBorrowed(usdtToBorrow, block.timestamp);
            
            // Approve GMX contract to spend USDT
            IERC20(usdtAddress).approve(gmxAddress, usdtToBorrow);
            
            // Transfer USDT to GMX and open a short position for the exact amount of ETH deposited
            IMockGMX(gmxAddress).depositCollateralAndOpenPositionWithSize(usdtToBorrow, totalPending, false, address(this));
            // Track the total USD value of the shorted ETH amount
            totalUsdValueShorted += ethValueInUsd; // Store total USD value in 18 decimals
            
            // Since we don't have a list of users for the current batch, we can't iterate directly.
            // Instead, note that userBatchContributions can be used post-transfer to update userUsdValueShorted
            // via a separate function or manual calculation based on eligibleCycleDay.
            // For simplicity, assume a separate update or future mechanism to update per-user shorted values.
            // Pseudo-code for reference (requires tracking current batch time):
            // uint256 currentBatchTime = getCurrentBatchTime(); // Need to define this based on timing logic
            // for each user with userBatchContributions[user][currentBatchTime] > 0:
            //     uint256 userEthContribution = userBatchContributions[user][currentBatchTime];
            //     uint256 userUsdValue = (userEthContribution * ethPrice) / 1e18;
            //     userUsdValueShorted[user] += userUsdValue;
            //     userBatchContributions[user][currentBatchTime] = 0; // Reset after transfer
            // totalBatchContributions[currentBatchTime] = 0; // Reset after transfer
            
            emit USDTTransferredToGMX(usdtToBorrow);
        }
    }

    // Internal function to calculate USDT to borrow (based on configurable percentage of ETH value in USD)
    function calculateUsdtToBorrow(uint ethAmount) internal view returns (uint) {
        (, int256 ethPrice, , , ) = IChainlinkPriceFeed(priceFeedAddress).latestRoundData();
        uint8 priceDecimals = IChainlinkPriceFeed(priceFeedAddress).decimals();
        // Convert ETH price to 18 decimals for calculation (ETH is 18 decimals)
        uint256 ethPriceAdjusted = uint256(ethPrice) * (10 ** (18 - priceDecimals));
        // Calculate total ETH value in USD (ETH amount * price per ETH)
        uint256 ethValueInUsd = (ethAmount * ethPriceAdjusted) / 10**18;
        // Calculate configurable percentage of ETH value
        uint256 borrowValueInUsd = (ethValueInUsd * usdtBorrowPercentage) / 100;
        // Assume 1 USDT = 1 USD, and USDT has 6 decimals
        uint256 usdtAmount = borrowValueInUsd / 10**(18 - 6);
        return usdtAmount;
    }

    // Function to get the balance of any address before transfer to Aave
    function getBalanceBeforeTransfer(address _address) public view returns (uint) {
        return balancesBeforeTransfer[_address];
    }

    // Function to get the contract's total aToken balance from Aave (for ETH)
    function getContractAaveBalance() public view returns (uint) {
        return IPool(aavePoolAddress).getATokenBalance(address(0), address(this));
    }

    // Function to get the latest ETH price in USD from Chainlink oracle
    function getLatestEthPrice() public view returns (uint256) {
        int256 price = IPriceFeed(priceFeedAddress).latestAnswer();
        require(price > 0, "Invalid price from oracle");
        return uint256(price); // Price is typically in 8 or 18 decimals, depending on the feed
    }

    // Function to allow receiving ETH directly for testing
    receive() external payable {}
} 