// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import './YToken.sol';
import '@openzeppelin/contracts/token/ERC20/IERC20.sol';

// interface with mock Aave contract
interface IPool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external payable;
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
    function getATokenBalance(address asset, address user) external view returns (uint256);
    function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf) external;
}

// for eth price feed
interface IChainlinkPriceFeed {
    function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
    function decimals() external view returns (uint8);
}

// Interface for MockGMX to interact with the mock GMX DEX contract
interface IMockGMX {
    function depositCollateralAndOpenPosition(uint256 amount, bool isLong, address onBehalfOf) external;
    function depositCollateralAndOpenPositionWithSize(uint256 amount, uint256 positionSize, bool isLong, address onBehalfOf) external;
}

// Event for YToken redemption and withdrawal
event YTokenRedeemed(address indexed user, uint256 yTokenAmount, uint256 ethWithdrawn, uint256 batchCycle);

// Event for user sending ETH to mint YTokens
event YTokenMinted(address indexed user, uint256 ethAmount, uint256 yTokenAmount, uint256 timestamp, uint256 batchCycle);

// Event for smart contract depositing ETH to Aave
event BulkDepositToAave(uint256 amount, uint256 timestamp);

// Event for USDT borrowing
event USDTBorrowed(uint256 usdtAmount, uint256 timestamp);

// Event for configuration update
event ConfigurationUpdated(uint256 depositsPerDay, uint256 cutoffHourHKT, uint256 cutoffMinuteHKT, uint256 borrowPercentage);

// Event for USDT transfer to GMX
event USDTTransferredToGMX(uint256 amount);

// Event for redemption requested
event RedemptionRequested(address indexed user, uint256 amount, uint256 timestamp);

// Event for daily metrics recorded
event DailyMetricsRecorded(uint256 timestamp, uint256 aTokenBalance, uint256 usdtDebt, int256 gmxFunding, int256 netFees);

// Event for bulk redemption from Aave
event BulkRedeemedFromAave(uint256 amount, uint256 timestamp);

// Event for no action needed, to be used for logging purposes
event NoActionNeeded(uint256 timestamp);

// Event for ETH distributed to user
event EthDistributedToUser(address indexed user, uint256 amount);

// Event for daily fees distributed
event DailyFeesDistributed(uint256 timestamp, int256 netFees, uint256 totalBatchContributions, uint256 batchCycleTimestamp);

// Event for fees claimed
event FeesClaimed(address indexed user, uint256 dayOrTimestamp, int256 feeShare);

// Event for redemption request queued
event RedemptionRequestQueued(address indexed user, uint256 yTokenAmount, uint256 batchCycle, uint256 timestamp);

// Event for bulk redemption processed from Aave, GMX, and USDT repayment
event BulkRedemptionProcessed(uint256 totalEthWithdrawn, uint256 usdtRepaid, uint256 ethShortCovered, uint256 timestamp);

// Extend IPool to get user account data for debt balance
interface IPoolExtended {
    function getUserAccountData(address user) external view returns (
        uint256 totalCollateralETH,
        uint256 totalDebtETH,
        uint256 availableBorrowsETH,
        uint256 currentLiquidationThreshold,
        uint256 ltv,
        uint256 healthFactor
    );
}

// Interface for GMX funding (adjust based on real GMX contract)
interface IGMX {
    function getPositionFunding(address account, address indexToken, bool isLong) external view returns (int256 fundingAmount);
}

/**
 * @title AaveYieldLock
 * @dev 

 */
contract AaveYieldLock {
    address payable public owner;
    address public aavePoolAddress;
    address public priceFeedAddress;
    address public usdtAddress;
    address public gmxAddress;
    
    YToken public yToken;
    
    // Keep mappings and variables related to ETH operations for the smart contract
    mapping(address => uint) public balancesBeforeTransfer;
    mapping(address => uint) public eligibleCycleDay;
    uint public totalATokenBalance;
    uint256 public totalAmountInAave;
    uint public totalBorrowedUSDT;
    uint public lastBulkTransferTime;
    uint256 public pendingDepositBalance;
    uint256 public totalEthDepositedToAave;
    uint256 public totalUsdValueShorted;
    mapping(address => uint256) public userUsdValueShorted;

    // Configuration variables for design and testing
    uint public depositsPerDay = 1; // Number of bulk deposits to Aave per day (default: 1)
    uint256 public usdtBorrowPercentage = 40; // Percentage of ETH value to borrow as USDT (default: 40%)

    // Mapping to track individual user deposits to Aave
    mapping(address => uint256) public userDepositedToAave; // Tracks per user ETH deposited to Aave
    
    // Add variables to track user contributions per batch cycle
    mapping(address => mapping(uint256 => uint256)) public userBatchContributions; // Tracks user ETH contributions per batch cycle (eligibleCycleDay)
    mapping(uint256 => uint256) public totalBatchContributions; // Tracks total ETH for each batch cycle
    
    // New mapping to track cumulative ETH deposited by each user across all batch cycles
    mapping(address => uint256) public userTotalEthDeposited; // Running total of ETH deposited by user

    // Track daily metrics for aToken balance, USDT debt, and GMX funding
    mapping(uint256 => uint256) public dailyATokenBalance; // ETH aToken balance at end of day
    mapping(uint256 => uint256) public dailyUsdtDebtBalance; // USDT debt balance at end of day
    mapping(uint256 => int256) public dailyGmxFunding; // GMX funding earned/owed at end of day
    mapping(uint256 => int256) public dailyNetFeesEarned; // Net fees (yield - interest + funding) per day
    
    // Mapping to track cumulative net fees earned per user
    mapping(address => int256) public userCumulativeFeesEarned;

    // Struct to store fee snapshots for each day with total batch contributions for the relevant cycle
    struct FeeSnapshot {
        int256 netFees;
        uint256 totalBatchContributions;
        uint256 batchCycleTimestamp; // Timestamp of the batch cycle associated with this day's fees
        bool isDistributed;
    }
    mapping(uint256 => FeeSnapshot) public historicalFeeSnapshots;
    
    // Mapping to track if a user has claimed fees for a specific day
    mapping(address => mapping(uint256 => bool)) public hasClaimed;

    // Add state variables for tracking pending redemptions
    uint256 public pendingRedemptionBalance; // Total ETH value requested for redemption
    mapping(address => uint256) public pendingRedemptions; // Tracks per-user pending redemption in YToken amount
    mapping(address => uint256) public redemptionBatchCycle; // Tracks the batch cycle for user's redemption request
    mapping(uint256 => uint256) public totalRedemptionRequestsPerBatch; // Tracks total YToken amount per batch cycle for redemption

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
        yToken = new YToken();
        yToken.transferOwnership(msg.sender); // Ensure owner can control minting/burning if needed
        
        emit YTokenMinted(msg.sender, msg.value, 0, block.timestamp, 0);
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

    // Function for users to send ETH and mint YTokens (previously called deposit)
    function mintYToken() external payable {
        require(msg.value > 0, "ETH amount must be greater than 0");
        balancesBeforeTransfer[msg.sender] += msg.value;
        pendingDepositBalance += msg.value;
        uint256 batchTime = getEligibleBatchTime();
        eligibleCycleDay[msg.sender] = batchTime;
        // Track user's contribution to this batch cycle
        userBatchContributions[msg.sender][batchTime] += msg.value;
        totalBatchContributions[batchTime] += msg.value;
        // Update user's cumulative ETH contributed total
        userTotalEthDeposited[msg.sender] += msg.value;
        
        // Issue YTokens based on ETH contribution value in USD
        uint256 ethPrice = getLatestEthPrice();
        uint256 usdValue = (msg.value * ethPrice) / 1e18; // Assuming ETH price is in 18 decimals
        yToken.mint(msg.sender, usdValue); // YToken pegged at $1, so 1 YToken = 1 USD
        
        emit YTokenMinted(msg.sender, msg.value, usdValue, block.timestamp, batchTime);
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

    // Function to check if current time is around midnight (12:00:00 AM) for processing on Day 2
    function isMidnightProcessingTime() public view returns (bool) {
        uint256 TIME_OFFSET = 30 * 60; // 30 minutes offset instead of HKT 8 hours
        uint256 SECONDS_PER_DAY = 86400;
        uint256 currentTimeAdjusted = (block.timestamp + TIME_OFFSET) % SECONDS_PER_DAY;
        // Midnight is 00:00, allow a small window around it (e.g., 00:00:00 to 00:05:00 for flexibility)
        uint256 midnightStart = 0;
        uint256 midnightEnd = 5 * 60; // 5 minutes after midnight
        return currentTimeAdjusted >= midnightStart && currentTimeAdjusted <= midnightEnd;
    }

    // Function for bulk deposit to Aave by the smart contract, callable by a bot, with immediate USDT borrow
    function bulkDepositToAave() public {
        require(isWithinDepositWindow(), "Not within deposit window");
        uint256 totalPending = pendingDepositBalance;
        require(totalPending > 0, "No pending ETH to deposit");
        
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
        (, int256 price, , , ) = IChainlinkPriceFeed(priceFeedAddress).latestRoundData();
        require(price > 0, "Invalid price from oracle");
        uint8 priceDecimals = IChainlinkPriceFeed(priceFeedAddress).decimals();
        // Convert price to 18 decimals for consistency with ETH calculations
        uint256 adjustedPrice = uint256(price) * (10 ** (18 - priceDecimals));
        return adjustedPrice; // Price adjusted to 18 decimals
    }

    // Function to allow receiving ETH directly for testing
    receive() external payable {}

    function getUserDepositPercentage(address user, uint256 batchCycle) public view returns (uint256) {
        uint256 userContribution = userBatchContributions[user][batchCycle];
        uint256 totalForBatch = totalBatchContributions[batchCycle];
        if (totalForBatch == 0) {
            return 0;
        }
        return (userContribution * 100) / totalForBatch;
    }

    // Function for users to request redemption of YTokens (queues the request instead of immediate processing)
    function requestRedemption(uint256 yTokenAmount, uint256 batchCycle) external {
        require(yToken.balanceOf(msg.sender) >= yTokenAmount, "Insufficient YToken balance");
        uint256 totalYTokenSupply = yToken.totalSupply();
        require(totalYTokenSupply > 0, "No YToken in circulation");
        
        // Burn YTokens immediately to prevent double-spending
        yToken.burn(msg.sender, yTokenAmount);
        
        // Queue the redemption request
        pendingRedemptions[msg.sender] += yTokenAmount;
        redemptionBatchCycle[msg.sender] = batchCycle;
        totalRedemptionRequestsPerBatch[batchCycle] += yTokenAmount;
        
        // Estimate ETH value for pending redemption balance (for reference, will be recalculated during processing)
        uint256 ethPrice = getLatestEthPrice();
        uint256 ethValue = (yTokenAmount * 1e18) / ethPrice; // Rough estimate, YToken pegged at $1
        pendingRedemptionBalance += ethValue;
        
        emit RedemptionRequestQueued(msg.sender, yTokenAmount, batchCycle, block.timestamp);
    }

    // Helper function to get total YToken supply (for proportion calculations)
    function getTotalYTokenSupply() public view returns (uint256) {
        return yToken.totalSupply();
    }

    // Function to process bulk redemptions from Aave, cover ETH short on GMX, and repay USDT to Aave
    function bulkRedemptionFromAave(uint256 batchCycle) public {
        require(isMidnightProcessingTime(), "Not within processing window"); // Use midnight check instead of deposit window
        uint256 totalYTokenToRedeem = totalRedemptionRequestsPerBatch[batchCycle];
        require(totalYTokenToRedeem > 0, "No pending redemptions for this batch cycle");
        
        // Calculate total USD value to redeem (YToken pegged at $1, plus fees if applicable)
        // For simplicity, initially just use YToken amount as USD value
        uint256 totalUsdValue = totalYTokenToRedeem; // Adjust if fees are calculated per batch
        
        // Get current ETH price to convert USD to ETH
        uint256 ethPrice = getLatestEthPrice();
        uint256 totalEthToWithdraw = (totalUsdValue * 1e18) / ethPrice;
        
        // Calculate corresponding USD value for short position and USDT debt to adjust
        uint256 totalUsdShorted = totalUsdValueShorted; // Total USD value of ETH shorted
        uint256 proportion = (totalUsdValue * 1e18) / (getTotalYTokenSupply() > 0 ? getTotalYTokenSupply() : 1); // Proportion of total supply being redeemed
        uint256 usdShortedToCover = (totalUsdShorted * proportion) / 1e18;
        uint256 ethShortToCover = (usdShortedToCover * 1e18) / ethPrice; // ETH amount to cover short
        uint256 usdtToRepay = (usdShortedToCover * usdtBorrowPercentage * 1e6) / (100 * 1e18); // USDT to repay based on borrow percentage
        
        // Step 1: Cover ETH short position on GMX (placeholder logic, adjust based on actual GMX interface)
        if (ethShortToCover > 0) {
            // IMockGMX(gmxAddress).closePositionPartially(ethShortToCover, false, address(this));
            totalUsdValueShorted -= usdShortedToCover;
        }
        
        // Step 2: Repay USDT debt to Aave (placeholder logic, adjust based on actual Aave interface)
        if (usdtToRepay > 0 && totalBorrowedUSDT >= usdtToRepay) {
            // IERC20(usdtAddress).approve(aavePoolAddress, usdtToRepay);
            // IPool(aavePoolAddress).repay(usdtAddress, usdtToRepay, 2, address(this));
            totalBorrowedUSDT -= usdtToRepay;
        }
        
        // Step 3: Withdraw ETH from Aave to cover the redemption
        if (address(this).balance < totalEthToWithdraw) {
            uint256 shortfall = totalEthToWithdraw - address(this).balance;
            uint256 withdrawnAmount = IPool(aavePoolAddress).withdraw(address(0), shortfall, address(this));
            totalEthDepositedToAave -= withdrawnAmount;
            emit BulkRedeemedFromAave(withdrawnAmount, block.timestamp);
        }
        
        // Update pending redemption balance (rough estimate, adjust if fees included)
        pendingRedemptionBalance = (pendingRedemptionBalance > totalEthToWithdraw) ? (pendingRedemptionBalance - totalEthToWithdraw) : 0;
        totalRedemptionRequestsPerBatch[batchCycle] = 0; // Reset for this batch
        
        emit BulkRedemptionProcessed(totalEthToWithdraw, usdtToRepay, ethShortToCover, block.timestamp);
    }

    // Function to distribute redeemed ETH to users after bulk redemption (call after bulkRedemptionFromAave)
    function distributeRedeemedEth(uint256 batchCycle) external {
        require(isWithinDepositWindow(), "Not within processing window");
        // This function would iterate through users with pending redemptions for the batchCycle
        // For simplicity, assume it's called after bulkRedemptionFromAave and ETH is in contract
        // In a real implementation, you'd track which users redeemed for this batch
        
        // Placeholder: Distribute based on pendingRedemptions mapping
        // This is a simplified version; a real implementation might need a list of users for the batch
        for (address user = address(0); user != address(0); user = address(0)) { // Replace with actual user iteration logic
            uint256 userYTokenAmount = pendingRedemptions[user];
            if (userYTokenAmount > 0 && redemptionBatchCycle[user] == batchCycle) {
                uint256 ethPrice = getLatestEthPrice();
                int256 netFeesEarned = userCumulativeFeesEarned[user];
                int256 totalUsdValue = int256(userYTokenAmount) + (netFeesEarned >= 0 ? netFeesEarned : -netFeesEarned);
                if (totalUsdValue <= 0) continue;
                
                uint256 ethToDistribute = uint256(totalUsdValue) * 1e18 / ethPrice;
                if (address(this).balance >= ethToDistribute) {
                    payable(user).transfer(ethToDistribute);
                    pendingRedemptions[user] = 0;
                    if (userYTokenAmount == yToken.balanceOf(user)) {
                        userCumulativeFeesEarned[user] = 0;
                    }
                    emit EthDistributedToUser(user, ethToDistribute);
                }
            }
        }
    }

    // Function to record daily metrics slightly before midnight (callable by anyone or bot)
    function recordDailyMetrics(uint256 dayOrTimestamp) external {
        uint256 prevDayOrTimestamp = dayOrTimestamp - 1 days; // Simplified, adjust if using different keying
        
        // Record aToken balance for ETH deposits and calculate yield
        uint256 currentATokenBalance = IPool(aavePoolAddress).getATokenBalance(address(0), address(this));
        dailyATokenBalance[dayOrTimestamp] = currentATokenBalance;
        uint256 yieldEarned = currentATokenBalance > dailyATokenBalance[prevDayOrTimestamp] 
            ? currentATokenBalance - dailyATokenBalance[prevDayOrTimestamp] 
            : 0;
        
        // Record USDT debt balance and calculate interest cost
        ( , uint256 totalDebtETH, , , , ) = IPoolExtended(aavePoolAddress).getUserAccountData(address(this));
        dailyUsdtDebtBalance[dayOrTimestamp] = totalDebtETH; // Adjust for USDT decimals if needed
        uint256 interestCost = totalDebtETH > dailyUsdtDebtBalance[prevDayOrTimestamp] 
            ? totalDebtETH - dailyUsdtDebtBalance[prevDayOrTimestamp] 
            : 0;
        
        // Record GMX funding for ETH short
        int256 currentFunding = IGMX(gmxAddress).getPositionFunding(address(this), address(0), false);
        dailyGmxFunding[dayOrTimestamp] = currentFunding;
        int256 fundingChange = currentFunding - dailyGmxFunding[prevDayOrTimestamp];
        
        // Calculate net fees earned (yield - interest + funding)
        // Note: Adjust for decimals and units as needed (e.g., convert all to USD or ETH equivalent)
        int256 netFees = int256(yieldEarned) - int256(interestCost) + fundingChange;
        dailyNetFeesEarned[dayOrTimestamp] = netFees;
        
        emit DailyMetricsRecorded(dayOrTimestamp, currentATokenBalance, totalDebtETH, currentFunding, netFees);
    }

    // Function to calculate net pending balance for a batch cycle (ETH deposits minus ETH equivalent of redemptions)
    function calculateNetPendingBalance(uint256 batchCycle) public view returns (int256) {
        uint256 totalDeposits = totalBatchContributions[batchCycle]; // ETH to be deposited for this batch
        uint256 totalRedemptions = totalRedemptionRequestsPerBatch[batchCycle]; // YToken amount (USD pegged)
        
        // Convert redemption YToken amount to ETH equivalent using current ETH price
        uint256 ethPrice = getLatestEthPrice(); // Price in 18 decimals (USD per ETH)
        uint256 redemptionEthEquivalent = (totalRedemptions * 1e18) / ethPrice; // Convert USD to ETH
        
        // Calculate net balance in ETH terms
        int256 netBalance = int256(totalDeposits) - int256(redemptionEthEquivalent);
        return netBalance;
    }

    // Function to process daily actions at midnight: handle deposits or redemptions based on net balance
    function processDailyActions(uint256 batchCycle) external {
        require(isMidnightProcessingTime(), "Not within processing window");
        
        // Calculate net pending balance for the batch cycle (deposits minus redemptions in ETH terms)
        int256 netBalance = calculateNetPendingBalance(batchCycle);
        
        if (netBalance > 0) {
            bulkDepositToAave();
        } else if (netBalance < 0) {
            bulkRedemptionFromAave(batchCycle);
        } else {
            emit NoActionNeeded(block.timestamp);
        }
    }

    // Function to distribute daily fees (store snapshot for later claims)
    function distributeDailyFees(uint256 dayOrTimestamp) external {
        int256 netFees = dailyNetFeesEarned[dayOrTimestamp];
        if (netFees == 0) return;
        
        // Determine the batch cycle timestamp associated with this day
        // For simplicity, assume dayOrTimestamp matches the batch cycle timestamp (e.g., fees on Day 3 are for batch at 12:00 AM Day 3)
        // In practice, you might need to adjust this based on your timing logic
        uint256 batchCycleTimestamp = dayOrTimestamp;
        uint256 totalBatchContrib = totalBatchContributions[batchCycleTimestamp];
        if (totalBatchContrib == 0) return;
        
        // Store the net fees and total batch contributions for later claims
        if (historicalFeeSnapshots[dayOrTimestamp].netFees == 0) {
            historicalFeeSnapshots[dayOrTimestamp] = FeeSnapshot(netFees, totalBatchContrib, batchCycleTimestamp, false);
            emit DailyFeesDistributed(dayOrTimestamp, netFees, totalBatchContrib, batchCycleTimestamp);
        }
    }
    
    // Function for users to claim their share of fees for a specific day based on batch contributions
    function claimFees(uint256 dayOrTimestamp) external {
        FeeSnapshot memory snapshot = historicalFeeSnapshots[dayOrTimestamp];
        require(snapshot.netFees != 0, "No fees recorded for this day");
        require(!hasClaimed[msg.sender][dayOrTimestamp], "Fees already claimed for this day");
        
        uint256 userContribution = userBatchContributions[msg.sender][snapshot.batchCycleTimestamp];
        require(userContribution > 0, "No contributions in this batch cycle to claim fees");
        
        // Calculate user's share of net fees based on batch contribution ratio
        int256 userFeeShare = (int256(userContribution) * snapshot.netFees) / int256(snapshot.totalBatchContributions);
        userCumulativeFeesEarned[msg.sender] += userFeeShare;
        hasClaimed[msg.sender][dayOrTimestamp] = true;
        
        // Optionally, if fees are in ETH or another token, transfer them here
        // For now, just update the cumulative tracking
        emit FeesClaimed(msg.sender, dayOrTimestamp, userFeeShare);
    }
    
    // Function to get a user's total ETH contributions to the contract across all batch cycles
    function getUserTotalContributions(address user) external view returns (uint256 total) {
        // Return the cumulative total of ETH deposited by the user
        return userTotalEthDeposited[user];
    }
}