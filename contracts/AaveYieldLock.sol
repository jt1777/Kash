// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import './YToken.sol';
import '@openzeppelin/contracts/token/ERC20/IERC20.sol';


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

interface IPriceFeed {
    function latestAnswer() external view returns (int256);
}

// Interface for MockGMX to interact with the mock GMX DEX contract
interface IMockGMX {
    function depositCollateralAndOpenPosition(uint256 amount, bool isLong, address onBehalfOf) external;
    function depositCollateralAndOpenPositionWithSize(uint256 amount, uint256 positionSize, bool isLong, address onBehalfOf) external;
}

// Event for YToken issuance
event YTokenIssued(address indexed user, uint256 amount, uint256 batchCycle);

// Event for YToken redemption and withdrawal
event YTokenRedeemed(address indexed user, uint256 yTokenAmount, uint256 ethWithdrawn, uint256 batchCycle);

// Event for user sending ETH to mint YTokens
event YTokenMinted(address indexed user, uint256 ethAmount, uint256 yTokenAmount, uint256 timestamp);

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
event BulkRedemptionFromAave(uint256 amount, uint256 timestamp);

// Event for bulk redemption processed
event BulkRedemptionProcessed(uint256 totalAmount);

// Event for no action needed
event NoActionNeeded(uint256 timestamp);

// Event for ETH distributed to user
event EthDistributedToUser(address indexed user, uint256 amount);

// Event for daily fees distributed
event DailyFeesDistributed(uint256 timestamp, int256 netFees, uint256 totalBatchContributions, uint256 batchCycleTimestamp);

// Event for fees claimed
event FeesClaimed(address indexed user, uint256 dayOrTimestamp, int256 feeShare);

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
    
    // Moved YToken declaration inside the contract
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
        
        emit YTokenMinted(msg.sender, msg.value, 0, block.timestamp);
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
        
        emit YTokenMinted(msg.sender, msg.value, usdValue, block.timestamp);
        emit YTokenIssued(msg.sender, usdValue, batchTime);
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

    // Function for bulk deposit to Aave by the smart contract, callable by a bot, with immediate USDT borrow
    function bulkDepositToAave() external {
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
        int256 price = IPriceFeed(priceFeedAddress).latestAnswer();
        require(price > 0, "Invalid price from oracle");
        return uint256(price); // Price is typically in 8 or 18 decimals, depending on the feed
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

    // Function for users to redeem YToken and withdraw their share plus net fees earned (only redemption method)
    function redeemYToken(uint256 yTokenAmount, uint256 batchCycle) external {
        require(yToken.balanceOf(msg.sender) >= yTokenAmount, "Insufficient YToken balance");
        uint256 totalYTokenSupply = yToken.totalSupply();
        require(totalYTokenSupply > 0, "No YToken in circulation");
        
        // Get the current ETH price in USD (assumed 18 decimals)
        uint256 ethPrice = getLatestEthPrice();
        require(ethPrice > 0, "Invalid ETH price from oracle");
        
        // Get user's net fees earned (assumed in USD value, same unit as YToken peg)
        int256 netFeesEarned = userCumulativeFeesEarned[msg.sender];
        
        // Calculate total USD value to redeem: YTokens (pegged at $1) + net fees earned
        // Adjust for potential negative fees
        int256 totalUsdValue;
        if (netFeesEarned >= 0) {
            totalUsdValue = int256(yTokenAmount) + netFeesEarned;
        } else {
            totalUsdValue = int256(yTokenAmount) - (-netFeesEarned);
        }
        require(totalUsdValue > 0, "Total value to redeem must be greater than 0");
        
        // Convert USD value to ETH amount (adjust for ETH price decimals, typically 18)
        uint256 ethToWithdraw = uint256(totalUsdValue) * 1e18 / ethPrice;
        
        // Ensure contract has enough ETH; if not, withdraw from Aave
        if (address(this).balance < ethToWithdraw) {
            uint256 shortfall = ethToWithdraw - address(this).balance;
            // Withdraw necessary ETH from Aave
            uint256 withdrawnAmount = IPool(aavePoolAddress).withdraw(address(0), shortfall, address(this));
            totalEthDepositedToAave -= withdrawnAmount;
            emit BulkRedemptionFromAave(withdrawnAmount, block.timestamp);
            
            // Adjust short position and repay USDT if necessary
            uint256 redeemedValueInUsd = (shortfall * ethPrice) / 1e18;
            uint256 usdtToRepay = (redeemedValueInUsd * usdtBorrowPercentage * 1e6) / (100 * 1e18);
            
            // Placeholder for closing short position on GMX
            // IMockGMX(gmxAddress).closePositionPartially(shortfall, false, address(this));
            totalUsdValueShorted -= redeemedValueInUsd;
            
            // Placeholder for repaying USDT debt on Aave
            if (usdtToRepay > 0 && totalBorrowedUSDT >= usdtToRepay) {
                // IPool(aavePoolAddress).repay(usdtAddress, usdtToRepay, 2, address(this));
                totalBorrowedUSDT -= usdtToRepay;
            }
        }
        
        require(address(this).balance >= ethToWithdraw, "Insufficient ETH balance in contract after withdrawal");
        
        // Burn the redeemed YToken
        yToken.burn(msg.sender, yTokenAmount);
        
        // Reset or adjust user's cumulative fees earned if fully redeemed
        if (yTokenAmount == yToken.balanceOf(msg.sender)) {
            userCumulativeFeesEarned[msg.sender] = 0;
        }
        
        // Transfer ETH to user
        payable(msg.sender).transfer(ethToWithdraw);
        
        emit YTokenRedeemed(msg.sender, yTokenAmount, ethToWithdraw, batchCycle);
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

    // Function to process daily actions at midnight: handle deposits (ETH operations for contract)
    function processDailyActions() external {
        require(isWithinDepositWindow(), "Not within deposit window");
        
        // Only handle deposits to Aave, no direct ETH redemptions for users
        if (pendingDepositBalance > 0) {
            uint256 totalPendingDeposit = pendingDepositBalance;
            IPool(aavePoolAddress).supply{value: totalPendingDeposit}(address(0), totalPendingDeposit, address(this), 0);
            pendingDepositBalance = 0;
            totalEthDepositedToAave += totalPendingDeposit;
            emit BulkDepositToAave(totalPendingDeposit, block.timestamp);
            
            // Borrow USDT based on deposited ETH value
            uint256 ethPrice = getLatestEthPrice();
            uint256 ethValueInUsd = (totalPendingDeposit * ethPrice) / 1e18;
            uint256 usdtToBorrow = (ethValueInUsd * usdtBorrowPercentage * 1e6) / (100 * 1e18); // USDT has 6 decimals
            if (usdtToBorrow > 0) {
                IPool(aavePoolAddress).borrow(usdtAddress, usdtToBorrow, 2, 0, address(this));
                totalBorrowedUSDT += usdtToBorrow;
                emit USDTBorrowed(usdtToBorrow, block.timestamp);
                
                IERC20(usdtAddress).approve(gmxAddress, usdtToBorrow);
                IMockGMX(gmxAddress).depositCollateralAndOpenPositionWithSize(usdtToBorrow, totalPendingDeposit, false, address(this));
                totalUsdValueShorted += ethValueInUsd;
                emit USDTTransferredToGMX(usdtToBorrow);
            }
        } else {
            // No action needed if no pending ETH to deposit
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