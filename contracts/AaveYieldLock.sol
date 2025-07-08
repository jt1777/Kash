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
    function repay(address asset, uint256 amount, uint256 rateMode, address onBehalfOf) external returns (uint256);
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
    function closePosition(address onBehalfOf) external;
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, address recipient) external returns (uint256 amountOut);
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
event ConfigurationUpdated(uint256 transactionsPerDay, uint256 cutoffHourHKT, uint256 cutoffMinuteHKT, uint256 borrowPercentage);

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

// Event for daily fees distributed to a user, maybe we don't really need this as much as the cumulative total.
event DailyUserFees(address indexed user, uint256 dayOrTimestamp, int256 feeAmount);

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
 * @dev this is a smart contract that allows users to deposit ETH and mint YTokens.
 * YTokens are short for Yield Tokens.  The yield comes from funding earned by shorting Eth on GMX, a perpetual DEX.  The smart contract sends Eth to Aave, then borrows USDT.  Part of the USDT is used to swap for more Eth, and part is sent to GMX to be used as collateral to short the full Eth exposure.  Net fees earned from these transactions are paid out to the users as yield.
 */

contract AaveYieldLock {
    address payable public owner;
    address public aavePoolAddress;
    address public priceFeedAddress;
    address public usdtAddress;
    address public gmxAddress;
    
    YToken public yToken;
    
    // Array to track all unique depositors
    address[] public allDepositors;
    // Mapping to check if an address is already in allDepositors to avoid duplicates
    mapping(address => bool) public isDepositor;
    
    // Keep mappings and variables related to ETH operations for the smart contract
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
    uint public transactionsPerDay = 1; // Number of bulk deposits to Aave per day (default: 1)
    uint256 public usdtBorrowPercentage = 70; // Percentage of ETH value to borrow as USDT (default: 70%)
    uint256 public depositorsPerFeeBatch = 50; // Number of depositors to process per batch for fee distribution (configurable)

    // Mapping to track individual user deposits to Aave
    mapping(address => uint256) public userDepositedToAave; // Tracks per user ETH deposited to Aave
    
    // Add variables to track user contributions per batch cycle
    mapping(address => mapping(uint256 => uint256)) public userBatchContributions; // Tracks user ETH contributions per batch cycle (eligibleCycleDay)
    mapping(uint256 => uint256) public totalBatchContributions; // Tracks total ETH for each batch cycle
    
    // mapping to track cumulative ETH deposited by each user across all batch cycles
    mapping(address => uint256) public userTotalEthDeposited; // Running total of ETH deposited by user

    // Track users who contributed to each batch (for distribution)
    mapping(uint256 => address[]) public batchContributors;
    // Track users who requested redemption in each batch
    mapping(uint256 => address[]) public batchRedeemers;

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

    // Add state variables for transaction window times
    uint public startHourHKT = 0; // Default start hour for transaction window
    uint public startMinuteHKT = 15; // Default start minute for transaction window
    uint public endHourHKT = 23; // Default end hour for transaction window
    uint public endMinuteHKT = 45; // Default end minute for transaction window

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
    function updateConfiguration(uint _transactionsPerDay, uint _cutoffHourHKT, uint _cutoffMinuteHKT, uint _borrowPercentage, uint _startHourHKT, uint _startMinuteHKT, uint _endHourHKT, uint _endMinuteHKT, uint _depositorsPerFeeBatch) external onlyOwner {
        require(_transactionsPerDay > 0, "Transactions per day must be greater than 0");
        require(_cutoffHourHKT < 24, "Cutoff hour must be between 0 and 23");
        require(_cutoffMinuteHKT < 60, "Cutoff minute must be between 0 and 59");
        require(_startHourHKT < 24, "Start hour must be between 0 and 23");
        require(_startMinuteHKT < 60, "Start minute must be between 0 and 59");
        require(_endHourHKT < 24, "End hour must be between 0 and 23");
        require(_endMinuteHKT < 60, "End minute must be between 0 and 59");
        require(_borrowPercentage == 40, "Borrow percentage must be exactly 40");
        require(_depositorsPerFeeBatch > 0, "Depositors per fee batch must be greater than 0");
        transactionsPerDay = _transactionsPerDay;
        usdtBorrowPercentage = _borrowPercentage;
        depositorsPerFeeBatch = _depositorsPerFeeBatch;
        // Store start and end times for transaction window (default set to start at 00:15 and end at 23:45)
        startHourHKT = _startHourHKT;
        startMinuteHKT = _startMinuteHKT;
        endHourHKT = _endHourHKT;
        endMinuteHKT = _endMinuteHKT;
        emit ConfigurationUpdated(_transactionsPerDay, _cutoffHourHKT, _cutoffMinuteHKT, _borrowPercentage);
    }

    // USER FUNCTIONS *******************************
    
    // Function for users to send ETH and mint YTokens (previously called deposit)
    function mintYToken() external payable {
        require(msg.value > 0, "ETH amount must be greater than 0");
        require(isWithinTransactionWindow(), "Not within deposit window");
        pendingDepositBalance += msg.value;
        // Calculate the next midnight (00:00 UTC) timestamp for batching
        uint256 SECONDS_PER_DAY = 86400;
        uint256 nextMidnight = ((block.timestamp / SECONDS_PER_DAY) + 1) * SECONDS_PER_DAY;
        eligibleCycleDay[msg.sender] = nextMidnight;
        // Track user's contribution to this batch cycle
        if (userBatchContributions[msg.sender][nextMidnight] == 0) {
            batchContributors[nextMidnight].push(msg.sender);
            // Add to allDepositors if not already added
            if (!isDepositor[msg.sender]) {
                allDepositors.push(msg.sender);
                isDepositor[msg.sender] = true;
            }
        }
        userBatchContributions[msg.sender][nextMidnight] += msg.value;
        totalBatchContributions[nextMidnight] += msg.value;
        // Update user's cumulative ETH contributed total
        userTotalEthDeposited[msg.sender] += msg.value;

        // Do NOT mint YTokens immediately. Minting will occur after batch processing.
        emit YTokenMinted(msg.sender, msg.value, 0, block.timestamp, nextMidnight);
    }

    // Function for users to request redemption of YTokens (queues the request instead of immediate processing)
    function requestRedemption(uint256 yTokenAmount) external {
        require(isWithinTransactionWindow(), "Not within deposit window");
        require(yToken.balanceOf(msg.sender) >= yTokenAmount, "Insufficient YToken balance");
        uint256 totalYTokenSupply = yToken.totalSupply();
        require(totalYTokenSupply > 0, "No YToken in circulation");

        // User must transfer YTokens to this contract for redemption
        bool success = yToken.transferFrom(msg.sender, address(this), yTokenAmount);
        require(success, "YToken transfer failed");

        // Calculate the next midnight (00:00 UTC) timestamp for batching
        uint256 SECONDS_PER_DAY = 86400;
        uint256 nextMidnight = ((block.timestamp / SECONDS_PER_DAY) + 1) * SECONDS_PER_DAY;

        // Queue the redemption request
        if (pendingRedemptions[msg.sender] == 0) {
        batchRedeemers[nextMidnight].push(msg.sender);
        }
        pendingRedemptions[msg.sender] += yTokenAmount;
        redemptionBatchCycle[msg.sender] = nextMidnight;
        totalRedemptionRequestsPerBatch[nextMidnight] += yTokenAmount;

        // Estimate ETH value for pending redemption balance (for reference, will be recalculated during processing)
        uint256 ethPrice = getLatestEthPrice();
        uint256 ethValue = (yTokenAmount * 1e18) / ethPrice; // Rough estimate, YToken pegged at $1
        pendingRedemptionBalance += ethValue;
        emit RedemptionRequestQueued(msg.sender, yTokenAmount, nextMidnight, block.timestamp);
    }

    // BOT FUNCTIONS *******************************

    // Function to process daily actions at midnight: handle deposits or redemptions based on net balance, record daily metrics, calculate fees, and distribute fees to depositors.
    function processDailyActions(uint256 batchCycle) external {
        require(isMidnightProcessingTime(), "Not within processing window");

        // Record daily metrics and calculate fees at the end of the day
        // Using a timestamp or day identifier for metrics recording
        uint256 dayOrTimestamp = block.timestamp / 1 days;
        recordDailyMetrics(dayOrTimestamp);
        calculateDailyContractFees(dayOrTimestamp);

        // Calculate net pending balance for the batch cycle (deposits minus redemptions in ETH terms)
        int256 netBalance = calculateNetPendingBalance(batchCycle);

        if (netBalance > 0) {
            bulkDepositToAave(batchCycle);
        } else if (netBalance < 0) {
            bulkRedemptionFromAave(batchCycle);
        } else {
            emit NoActionNeeded(block.timestamp);
        }
        
        // Always call both distribution functions to ensure users receive their tokens and ETH
        this.distributeYTokens(batchCycle);
        this.distributeRedeemedEth(batchCycle);

        // Calculate daily fees for all depositors in configurable batch sizes
        uint256 totalDepositors = allDepositors.length;
        if (totalDepositors > 0) {
            uint256 startIndex = 0;
            while (startIndex < totalDepositors) {
                uint256 endIndex = startIndex + depositorsPerFeeBatch - 1;
                if (endIndex >= totalDepositors) {
                    endIndex = totalDepositors - 1;
                }
                this.calculateDailyFeesForRange(dayOrTimestamp, startIndex, endIndex);
                startIndex = endIndex + 1;
            }
        }
    }

    // Function to get the total number of depositors
    function getDepositorCount() external view returns (uint256) {
        return allDepositors.length;
    }
    
    // Bot function to calculate daily fees for a batch of depositors
    function calculateDailyFeesForRange(uint256 dayOrTimestamp, uint256 startIndex, uint256 endIndex) external onlyOwner {
        FeeSnapshot memory snapshot = historicalFeeSnapshots[dayOrTimestamp];
        require(snapshot.netFees != 0, "No fees recorded for this day");
        require(startIndex <= endIndex, "Invalid index range");
        require(endIndex < allDepositors.length, "End index out of bounds");
        
        for (uint256 i = startIndex; i <= endIndex; i++) {
            address user = allDepositors[i];
            if (!hasClaimed[user][dayOrTimestamp]) {
                uint256 userProportion = this.getUserShareOfDailyFees(user);
                int256 userFeeShare = (snapshot.netFees * int256(userProportion)) / int256(1e18);
                userCumulativeFeesEarned[user] += userFeeShare;
                hasClaimed[user][dayOrTimestamp] = true;
                emit DailyUserFees(user, dayOrTimestamp, userFeeShare);
            }
        }
        // If this is the last range for the day, mark as distributed
        if (endIndex == allDepositors.length - 1) {
            historicalFeeSnapshots[dayOrTimestamp].isDistributed = true;
        }
    }

    // SMART CONTRACT FUNCTIONS *******************************

    /**
     * @dev For the smart contract to deposit the net amount of ETH (deposits minus redemptions) for the given batchCycle.  Only deposits if the net amount is positive. Uses calculateNetPendingBalance.  Updates state and emits events.
     */
    function bulkDepositToAave(uint256 batchCycle) public {
        int256 netBalance = calculateNetPendingBalance(batchCycle);
        uint256 netDepositAmount = uint256(netBalance);
        require(netDepositAmount > 0 && netDepositAmount <= pendingDepositBalance, "Invalid net deposit amount");

        // Deposit net ETH to Aave and receive aTokens
        IPool(aavePoolAddress).supply{value: netDepositAmount}(address(0), netDepositAmount, address(this), 0);
        pendingDepositBalance -= netDepositAmount;
        totalEthDepositedToAave += netDepositAmount;
        emit BulkDepositToAave(netDepositAmount, block.timestamp);

        // Borrow USDT based on the deposited ETH value
        uint256 ethPrice = getLatestEthPrice();
        uint256 ethValueInUsd = (netDepositAmount * ethPrice) / 1e18;
        uint256 usdtToBorrow = (ethValueInUsd * usdtBorrowPercentage * 1e6) / (100 * 1e18); // USDT has 6 decimals
        if (usdtToBorrow > 0) {
            IPool(aavePoolAddress).borrow(usdtAddress, usdtToBorrow, 2, 0, address(this));
            totalBorrowedUSDT += usdtToBorrow;
            emit USDTBorrowed(usdtToBorrow, block.timestamp);

            // Approve GMX contract to spend USDT
            IERC20(usdtAddress).approve(gmxAddress, usdtToBorrow);

            // Swap USDT to ETH via GMX
            uint256 ethReceived = IMockGMX(gmxAddress).swap(usdtAddress, address(0), usdtToBorrow, 0, address(this));
            emit USDTTransferredToGMX(usdtToBorrow);

            // Use received ETH as collateral to open a short ETH position
            uint256 shortSize = (netDepositAmount * (100 + usdtBorrowPercentage)) / 100;
            IMockGMX(gmxAddress).depositCollateralAndOpenPositionWithSize(ethReceived, shortSize, false, address(this));
            // Track the total USD value of the shorted ETH amount
            totalUsdValueShorted += (shortSize * ethPrice) / 1e18; // Store total USD value in 18 decimals
        }
    }

    // Function to distribute YTokens to users after batch processing, this is the end of the MINTING process
    function distributeYTokens(uint256 batchCycle) external {
        uint256 totalForBatch = totalBatchContributions[batchCycle];
        require(totalForBatch > 0, "No ETH contributions for this batch");
        address[] memory contributors = batchContributors[batchCycle];
        for (uint256 i = 0; i < contributors.length; i++) {
            address user = contributors[i];
            uint256 userContribution = userBatchContributions[user][batchCycle];
            uint256 ethPrice = getLatestEthPrice();
            uint256 yTokenAmount = (userContribution * ethPrice) / 1e18;
            yToken.mint(user, yTokenAmount);
            emit YTokenMinted(user, userContribution, yTokenAmount, block.timestamp, batchCycle);
        }
    }

    // Function to process bulk redemptions from Aave: Cover ETH short on GMX, swap Eth collateral to USDT and then repay USDT loan to Aave, then withdraw Eth.  This is called by the smart contract, not the user.
    function bulkRedemptionFromAave(uint256 batchCycle) public {
        int256 netBalance = calculateNetPendingBalance(batchCycle);
        uint256 totalEthToWithdraw = uint256(-netBalance);
        require(totalEthToWithdraw > 0 && totalEthToWithdraw <= totalEthDepositedToAave, "Invalid redemption amount");

        // Get current ETH price to convert USD to ETH
        uint256 ethPrice = getLatestEthPrice();

        // Simplified calculation: ETH to cover is based directly on totalEthToWithdraw * (1 + usdtBorrowPercentage/100)
        uint256 ethShortToCover = (totalEthToWithdraw * (100 + usdtBorrowPercentage)) / 100;
        uint256 usdShortedToCover = (ethShortToCover * ethPrice) / 1e18;
        uint256 usdtToRepay = (usdShortedToCover * usdtBorrowPercentage * 1e6) / (100 * 1e18); // USDT to repay based on borrow percentage
        
        // Step 1: Cover ETH short position on GMX
        if (ethShortToCover > 0) {
            IMockGMX(gmxAddress).closePosition(address(this));
            totalUsdValueShorted -= usdShortedToCover;
        }
        
        // Step 1.5: Swap ETH collateral back to USDT via GMX
        uint256 ethBalance = address(this).balance;
        if (ethBalance > 0 && usdtToRepay > 0) {
            IMockGMX(gmxAddress).swap(address(0), usdtAddress, ethBalance, 0, address(this));
        }
        
        // Step 2: Repay USDT debt to Aave
        if (usdtToRepay > 0 && totalBorrowedUSDT >= usdtToRepay) {
            IERC20(usdtAddress).approve(aavePoolAddress, usdtToRepay);
            IPool(aavePoolAddress).repay(usdtAddress, usdtToRepay, 2, address(this));
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
        
        // Distribute redeemed ETH and associated fees to users
        this.distributeRedeemedEth(batchCycle);
        
        emit BulkRedemptionProcessed(totalEthToWithdraw, usdtToRepay, ethShortToCover, block.timestamp);
    }

    // Function to distribute redeemed ETH to users after bulk redemption (call after bulkRedemptionFromAave).  Includes distribution of user fees.  This is the end of the REDEMPTION process.
    function distributeRedeemedEth(uint256 batchCycle) external {
        require(isWithinTransactionWindow(), "Not within processing window");
        // Iterate through users who requested redemption for this batch cycle
        address[] memory redeemers = batchRedeemers[batchCycle];
        uint256 ethPrice = getLatestEthPrice();
        
        for (uint256 i = 0; i < redeemers.length; i++) {
            address user = redeemers[i];
            uint256 userYTokenAmount = pendingRedemptions[user];
            if (userYTokenAmount > 0 && redemptionBatchCycle[user] == batchCycle) {
                // Calculate ETH to distribute based on YToken amount (pegged to USD)
                uint256 ethToDistribute = (userYTokenAmount * 1e18) / ethPrice;
                // Ensure contract has enough ETH to distribute
                if (address(this).balance >= ethToDistribute) {
                    // Automatically claim fees for the user to handle any negative fees
                    if (userCumulativeFeesEarned[user] > 0) {
                        distributeUserFees(user);
                    }
                    payable(user).transfer(ethToDistribute);
                    pendingRedemptions[user] = 0;
                    emit EthDistributedToUser(user, ethToDistribute);
                } else {
                    // If insufficient balance, log or handle partial distribution if needed
                    emit NoActionNeeded(block.timestamp); // Placeholder for logging insufficient balance
                }
            }
        }
    }

    // Function for the contract to send fees to the user automatically after redemption
    function distributeUserFees(address user) public {
        int256 feesEarned = userCumulativeFeesEarned[user];
        require(feesEarned > 0, "No fees to claim");
        
        uint256 ethToDistribute = uint256(feesEarned);
        require(address(this).balance >= ethToDistribute, "Insufficient contract balance to pay fees");
        
        // Reset the user's cumulative fees to zero after claiming
        userCumulativeFeesEarned[user] = 0;
        
        // Transfer the ETH equivalent of the fees to the user
        payable(user).transfer(ethToDistribute);
        
        emit EthDistributedToUser(user, ethToDistribute);
    }

    // Function to get a user's total ETH contributions to the contract across all batch cycles
    function getUserTotalContributions(address user) external view returns (uint256 total) {
        // Return the cumulative total of ETH deposited by the user
        return userTotalEthDeposited[user];
    }

    // Function to get the total amount of ETH deposited by the SC to Aave across all batch cycles
    function getTotalEthDepositedToAave() external view returns (uint256) {
        return totalEthDepositedToAave;
    }

    // Function to get a user's share of daily fees. It is the proportion of his/her total ETH deposited to the total ETH deposited by the SC to Aave
    function getUserShareOfDailyFees(address user) external view returns (uint256) {
        if (totalEthDepositedToAave == 0) {
            return 0;
        }
        // Calculate share as a percentage (multiplied by 1e18 for precision)
        return (userTotalEthDeposited[user] * 1e18) / totalEthDepositedToAave;
    }

    // Function to calculate daily contract fees for the Smart Contract (store snapshot for later claims)
    function calculateDailyContractFees(uint256 dayOrTimestamp) public {
        int256 netFees = dailyNetFeesEarned[dayOrTimestamp];
        if (netFees == 0) return;
        
        // Determine the batch cycle timestamp associated with this day
        // For simplicity, assume dayOrTimestamp matches the batch cycle timestamp (e.g., fees on Day 3 are for batch at 12:00 AM Day 3)
        uint256 batchCycleTimestamp = dayOrTimestamp;
        uint256 totalBatchContrib = totalBatchContributions[batchCycleTimestamp];
        if (totalBatchContrib == 0) return;
        
        // Store the net fees and total batch contributions for later claims
        if (historicalFeeSnapshots[dayOrTimestamp].netFees == 0) {
            historicalFeeSnapshots[dayOrTimestamp] = FeeSnapshot(netFees, totalBatchContrib, batchCycleTimestamp, false);
            emit DailyFeesDistributed(dayOrTimestamp, netFees, totalBatchContrib, batchCycleTimestamp);
        }
    }

    // HELPER FUNCTIONS *******************************

    // Function to check if current time is within the transactions window for bulk transfer to Aave
    function isWithinTransactionWindow() public view returns (bool) {
        uint256 SECONDS_PER_DAY = 86400;
        uint256 currentTimeOfDay = block.timestamp % SECONDS_PER_DAY;
        // Calculate window start and end in seconds since midnight
        uint256 windowStart = (startHourHKT * 3600) + (startMinuteHKT * 60);
        uint256 windowEnd = (endHourHKT * 3600) + (endMinuteHKT * 60);
        if (currentTimeOfDay >= windowStart && currentTimeOfDay <= windowEnd) {
            return true; // Within the deposit window
        }
        return false; // Outside the window
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

    // Function to record daily metrics slightly before midnight
    function recordDailyMetrics(uint256 dayOrTimestamp) public {
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

    // Helper Function to calculate net pending balance for a batch cycle (ETH deposits minus ETH equivalent of redemptions)
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

    // Helper function to get total YToken supply (for proportion calculations)
    function getTotalYTokenSupply() public view returns (uint256) {
        return yToken.totalSupply();
    }

    // to determine how much USDT to borrow from Aave
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
    
    // Function to get the contract's total aToken balance from Aave (for ETH that was deposited)
    function getContractAaveBalance() public view returns (uint) {
        return IPool(aavePoolAddress).getATokenBalance(address(0), address(this));
    }

    function getLatestEthPrice() public view returns (uint256) {
        (, int256 price, , , ) = IChainlinkPriceFeed(priceFeedAddress).latestRoundData();
        require(price > 0, "Invalid price from oracle");
        uint8 priceDecimals = IChainlinkPriceFeed(priceFeedAddress).decimals();
        // Convert price to 18 decimals for consistency with ETH calculations
        uint256 adjustedPrice = uint256(price) * (10 ** (18 - priceDecimals));
        return adjustedPrice; // Price adjusted to 18 decimals
    }

    // this is per batch, maybe not useful
    function getUserDepositPercentage(address user, uint256 batchCycle) public view returns (uint256) {
        uint256 userContribution = userBatchContributions[user][batchCycle];
        uint256 totalForBatch = totalBatchContributions[batchCycle];
        if (totalForBatch == 0) {
            return 0;
        }
        return (userContribution * 100) / totalForBatch;
    }

    // Function to perform a token swap via GMX
    function swapViaGMX(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut) external returns (uint256) {
        require(amountIn > 0, "Swap amount must be greater than 0");
        IERC20(tokenIn).approve(gmxAddress, amountIn);
        uint256 amountOut = IMockGMX(gmxAddress).swap(tokenIn, tokenOut, amountIn, minAmountOut, address(this));
        return amountOut;
    }
}