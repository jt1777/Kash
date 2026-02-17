// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import './KashEthToken.sol';
import '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';

// Asset type enum for multi-asset support
enum AssetType { ETH, WETH, WBTC, USDT, USDC }

// Aave V3 Pool interface
interface IPool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external payable;
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
    function getUserAccountData(address user) external view returns (
        uint256 totalCollateralBase,
        uint256 totalDebtBase,
        uint256 availableBorrowsBase,
        uint256 currentLiquidationThreshold,
        uint256 ltv,
        uint256 healthFactor
    );
    function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf) external;
    function repay(address asset, uint256 amount, uint256 rateMode, address onBehalfOf) external returns (uint256);
}

// Chainlink Price Feed interface
interface IChainlinkPriceFeed {
    function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
    function decimals() external view returns (uint8);
}

// Hyperliquid interface
interface IHyperliquid {
    function depositCollateralAndOpenShort(uint256 usdcAmount, uint256 positionSizeUsd, address onBehalfOf) external;
    function closePosition(address onBehalfOf) external returns (uint256 collateralReturned, int256 pnl);
    function getPositionFunding(address account) external view returns (int256);
    function accrueFunding(address account) external;
    function getPosition(address account) external view returns (
        uint256 collateral,
        uint256 positionSize,
        uint256 entryPrice,
        bool isLong,
        bool isOpen,
        int256 funding
    );
}

// Events
event KashEthMinted(address indexed user, address indexed asset, uint256 assetAmount, uint256 kashEthAmount, uint256 timestamp, uint256 batchCycle);
event KashEthRedeemed(address indexed user, uint256 kashEthAmount, uint256 assetAmount, uint256 assetType, uint256 batchCycle);
event BulkDepositToAave(address indexed asset, uint256 amount, uint256 timestamp);
event USDCBorrowed(uint256 usdcAmount, uint256 timestamp);
event USDCDepositedToHyperliquid(uint256 amount, uint256 timestamp);
event PositionClosed(uint256 usdcReturned, int256 pnl, uint256 timestamp);
event BulkRedemptionProcessed(uint256 totalAssetWithdrawn, uint256 usdcRepaid, uint256 timestamp);
event DailyMetricsRecorded(uint256 timestamp, uint256 totalCollateral, uint256 usdcDebt, int256 hyperliquidFunding, int256 netFees);
event DailyFeesDistributed(uint256 timestamp, int256 netFees, uint256 totalBatchContributions);
event ConfigurationUpdated(uint256 transactionsPerDay, uint256 borrowPercentage, uint256 leverage);
event RedemptionRequestQueued(address indexed user, uint256 kashEthAmount, uint256 batchCycle, uint256 timestamp);
event AssetDistributedToUser(address indexed user, address indexed asset, uint256 amount);

/**
 * @title KashYield
 * @dev Multi-asset yield vault using Aave + Hyperliquid
 * Users deposit ETH/wETH (future: wBTC, USDT, USDC) → Mint KashEth → Earn yield from funding fees
 */
contract KashYield {
    using SafeERC20 for IERC20;
    
    // ============ State Variables ============
    
    address payable public owner;
    address public aavePoolAddress;
    address public priceFeedAddress; // ETH/USD price feed
    address public usdcAddress;
    address public hyperliquidAddress;
    address public wethAddress; // Wrapped ETH address
    
    KashEth public kashEth;
    
    // Supported assets (ETH is address(0))
    mapping(AssetType => address) public assetAddresses;
    mapping(address => AssetType) public assetTypeByAddress;
    mapping(AssetType => bool) public isAssetSupported;
    AssetType[] public supportedAssets;
    
    // User tracking
    address[] public allDepositors;
    mapping(address => bool) public isDepositor;
    
    // Batching system
    mapping(address => mapping(uint256 => mapping(AssetType => uint256))) public userBatchContributions;
    mapping(uint256 => mapping(AssetType => uint256)) public totalBatchContributions;
    mapping(uint256 => address[]) public batchContributors;
    mapping(uint256 => mapping(address => bool)) public isContributorInBatch;
    
    // Redemption system
    mapping(address => mapping(uint256 => uint256)) public pendingRedemptionsPerBatch;
    mapping(uint256 => address[]) public batchRedeemers;
    mapping(uint256 => uint256) public totalRedemptionRequestsPerBatch;
    
    // Protocol positions
    uint256 public totalUsdcBorrowed;
    uint256 public totalHyperliquidCollateral;
    uint256 public hyperliquidPositionSize;
    bool public isHyperliquidPositionOpen;
    
    // User totals
    mapping(address => uint256) public userTotalUsdDeposited;
    mapping(address => int256) public userCumulativeFeesEarned;
    
    // Configuration
    uint256 public transactionsPerDay = 1;
    uint256 public usdcBorrowPercentage = 70; // 70% of collateral value
    uint256 public leverage = 170; // 1.7x = 170 (in basis points)
    uint256 public depositorsPerFeeBatch = 50;
    uint256 public processingDelaySeconds = 23 * 3600; // 23 hours
    uint256 public lastProcessedTimestamp;
    
    // Time windows (HKT)
    uint256 public startHourHKT = 0;
    uint256 public startMinuteHKT = 15;
    uint256 public endHourHKT = 23;
    uint256 public endMinuteHKT = 45;
    
    // Daily metrics
    mapping(uint256 => uint256) public dailyTotalCollateral;
    mapping(uint256 => uint256) public dailyUsdcDebt;
    mapping(uint256 => int256) public dailyHyperliquidFunding;
    mapping(uint256 => int256) public dailyNetFeesEarned;
    
    struct FeeSnapshot {
        int256 netFees;
        uint256 totalBatchContributions;
        uint256 batchCycleTimestamp;
        bool isDistributed;
    }
    mapping(uint256 => FeeSnapshot) public historicalFeeSnapshots;
    mapping(address => mapping(uint256 => bool)) public hasClaimed;
    
    // ============ Modifiers ============
    
    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner");
        _;
    }
    
    // ============ Constructor ============
    
    constructor(
        address _aavePoolAddress,
        address _usdcAddress,
        address _priceFeedAddress,
        address _hyperliquidAddress,
        address _wethAddress
    ) payable {
        owner = payable(msg.sender);
        aavePoolAddress = _aavePoolAddress;
        usdcAddress = _usdcAddress;
        priceFeedAddress = _priceFeedAddress;
        hyperliquidAddress = _hyperliquidAddress;
        wethAddress = _wethAddress;
        
        kashEth = new KashEth();
        kashEth.transferOwnership(address(this));
        
        // Initialize supported assets
        assetAddresses[AssetType.ETH] = address(0);
        assetAddresses[AssetType.WETH] = _wethAddress;
        
        assetTypeByAddress[address(0)] = AssetType.ETH;
        assetTypeByAddress[_wethAddress] = AssetType.WETH;
        
        isAssetSupported[AssetType.ETH] = true;
        isAssetSupported[AssetType.WETH] = true;
        supportedAssets.push(AssetType.ETH);
        supportedAssets.push(AssetType.WETH);
        
        emit KashEthMinted(msg.sender, address(0), msg.value, 0, block.timestamp, 0);
    }
    
    // ============ Admin Functions ============
    
    function updateConfiguration(
        uint256 _transactionsPerDay,
        uint256 _borrowPercentage,
        uint256 _leverage,
        uint256 _depositorsPerFeeBatch,
        uint256 _processingDelaySeconds,
        uint256 _startHourHKT,
        uint256 _startMinuteHKT,
        uint256 _endHourHKT,
        uint256 _endMinuteHKT
    ) external onlyOwner {
        require(_transactionsPerDay > 0, "Invalid transactionsPerDay");
        require(_borrowPercentage <= 75, "Borrow percentage max 75%");
        require(_leverage >= 100 && _leverage <= 200, "Leverage 1-2x");
        require(_depositorsPerFeeBatch > 0, "Invalid batch size");
        require(_processingDelaySeconds >= 3600, "Min 1 hour delay");
        
        transactionsPerDay = _transactionsPerDay;
        usdcBorrowPercentage = _borrowPercentage;
        leverage = _leverage;
        depositorsPerFeeBatch = _depositorsPerFeeBatch;
        processingDelaySeconds = _processingDelaySeconds;
        startHourHKT = _startHourHKT;
        startMinuteHKT = _startMinuteHKT;
        endHourHKT = _endHourHKT;
        endMinuteHKT = _endMinuteHKT;
        
        emit ConfigurationUpdated(_transactionsPerDay, _borrowPercentage, _leverage);
    }
    
    function addSupportedAsset(AssetType assetType, address assetAddress) external onlyOwner {
        require(!isAssetSupported[assetType], "Asset already supported");
        require(assetAddress != address(0) || assetType == AssetType.ETH, "Invalid address");
        
        assetAddresses[assetType] = assetAddress;
        if (assetAddress != address(0)) {
            assetTypeByAddress[assetAddress] = assetType;
        }
        isAssetSupported[assetType] = true;
        supportedAssets.push(assetType);
    }
    
    // ============ User Functions ============
    
    /**
     * @dev Deposit ETH and queue for batch minting
     */
    function depositETH() external payable {
        require(msg.value > 0, "Amount must be > 0");
        require(isWithinTransactionWindow(), "Outside deposit window");
        require(isAssetSupported[AssetType.ETH], "ETH not supported");
        
        uint256 batchCycle = getNextMidnightTimestamp();
        
        _recordContribution(msg.sender, AssetType.ETH, msg.value, batchCycle);
        
        emit KashEthMinted(msg.sender, address(0), msg.value, 0, block.timestamp, batchCycle);
    }
    
    /**
     * @dev Deposit WETH and queue for batch minting
     */
    function depositWETH(uint256 amount) external {
        require(amount > 0, "Amount must be > 0");
        require(isWithinTransactionWindow(), "Outside deposit window");
        require(isAssetSupported[AssetType.WETH], "WETH not supported");
        
        IERC20(wethAddress).safeTransferFrom(msg.sender, address(this), amount);
        
        uint256 batchCycle = getNextMidnightTimestamp();
        
        _recordContribution(msg.sender, AssetType.WETH, amount, batchCycle);
        
        emit KashEthMinted(msg.sender, wethAddress, amount, 0, block.timestamp, batchCycle);
    }
    
    /**
     * @dev Internal function to record user contributions
     */
    function _recordContribution(address user, AssetType assetType, uint256 amount, uint256 batchCycle) internal {
        if (userBatchContributions[user][batchCycle][assetType] == 0) {
            if (!isContributorInBatch[batchCycle][user]) {
                batchContributors[batchCycle].push(user);
                isContributorInBatch[batchCycle][user] = true;
            }
            if (!isDepositor[user]) {
                allDepositors.push(user);
                isDepositor[user] = true;
            }
        }
        
        userBatchContributions[user][batchCycle][assetType] += amount;
        totalBatchContributions[batchCycle][assetType] += amount;
        
        // Convert to USD for tracking
        uint256 usdValue = convertAssetToUsd(assetType, amount);
        userTotalUsdDeposited[user] += usdValue;
    }
    
    /**
     * @dev Request redemption of KashEth (batched)
     */
    function requestRedemption(uint256 kashEthAmount) external {
        require(kashEthAmount > 0, "Amount must be > 0");
        require(isWithinTransactionWindow(), "Outside window");
        require(kashEth.balanceOf(msg.sender) >= kashEthAmount, "Insufficient balance");
        
        kashEth.transferFrom(msg.sender, address(this), kashEthAmount);
        
        uint256 batchCycle = getNextMidnightTimestamp();
        
        if (pendingRedemptionsPerBatch[msg.sender][batchCycle] == 0) {
            batchRedeemers[batchCycle].push(msg.sender);
        }
        pendingRedemptionsPerBatch[msg.sender][batchCycle] += kashEthAmount;
        totalRedemptionRequestsPerBatch[batchCycle] += kashEthAmount;
        
        emit RedemptionRequestQueued(msg.sender, kashEthAmount, batchCycle, block.timestamp);
    }
    
    /**
     * @dev Get accumulated fees for user
     */
    function getAccumulatedFees() external view returns (int256) {
        return userCumulativeFeesEarned[msg.sender];
    }
    
    // ============ Batch Processing (Bot/Automated) ============
    
    /**
     * @dev Process daily batch - deposits, redemptions, fee distribution
     */
    function processDailyActions(uint256 batchCycle) external onlyOwner {
        require(isMidnightProcessingTime(), "Outside processing window");
        require(block.timestamp >= lastProcessedTimestamp + processingDelaySeconds, "Already processed");
        
        uint256 dayOrTimestamp = block.timestamp / 1 days;
        
        // Record metrics before processing
        recordDailyMetrics(dayOrTimestamp);
        
        // Calculate net batch value (deposits - redemptions)
        (int256 netUsdValue, uint256 totalDepositsUsd, uint256 totalRedemptionsUsd) = calculateNetBatchValue(batchCycle);
        
        if (netUsdValue > 0) {
            // Net deposits - add to position
            _processNetDeposit(batchCycle, uint256(netUsdValue), totalDepositsUsd);
        } else if (netUsdValue < 0) {
            // Net redemptions - reduce position
            _processNetRedemption(batchCycle, uint256(-netUsdValue), totalRedemptionsUsd);
        }
        
        // Distribute KashEth to depositors
        distributeKashEths(batchCycle);
        
        // Distribute assets to redeemers
        distributeRedeemedAssets(batchCycle);
        
        // Calculate fees for depositors
        calculateDailyFees(dayOrTimestamp);
        
        lastProcessedTimestamp = block.timestamp;
    }
    
    /**
     * @dev Process net deposits - supply to Aave, borrow USDC, deposit to Hyperliquid
     */
    function _processNetDeposit(uint256 batchCycle, uint256 netUsdValue, uint256 totalDepositsUsd) internal {
        // Convert batch deposits to ETH and supply to Aave
        uint256 ethToSupply = convertUsdToEth(netUsdValue);
        
        // Supply ETH to Aave
        IPool(aavePoolAddress).supply{value: ethToSupply}(address(0), ethToSupply, address(this), 0);
        emit BulkDepositToAave(address(0), ethToSupply, block.timestamp);
        
        // Borrow USDC (70% of deposited value)
        uint256 usdcToBorrow = (netUsdValue * usdcBorrowPercentage * 1e6) / (100 * 1e18); // USDC has 6 decimals
        
        if (usdcToBorrow > 0) {
            IPool(aavePoolAddress).borrow(usdcAddress, usdcToBorrow, 2, 0, address(this));
            totalUsdcBorrowed += usdcToBorrow;
            emit USDCBorrowed(usdcToBorrow, block.timestamp);
            
            // Calculate position size (1.7x leverage on the collateral value)
            uint256 positionSizeUsd = (netUsdValue * leverage) / 100;
            
            // Deposit USDC to Hyperliquid and open 1.7x ETH short
            IERC20(usdcAddress).approve(hyperliquidAddress, usdcToBorrow);
            IHyperliquid(hyperliquidAddress).depositCollateralAndOpenShort(usdcToBorrow, positionSizeUsd, address(this));
            
            totalHyperliquidCollateral += usdcToBorrow;
            hyperliquidPositionSize += positionSizeUsd;
            isHyperliquidPositionOpen = true;
            
            emit USDCDepositedToHyperliquid(usdcToBorrow, block.timestamp);
        }
    }
    
    /**
     * @dev Process net redemptions - close portion of position, repay USDC, withdraw ETH
     */
    function _processNetRedemption(uint256 batchCycle, uint256 netUsdValue, uint256 totalRedemptionsUsd) internal {
        // Calculate proportional amount to unwind
        uint256 redemptionRatio = (netUsdValue * 1e18) / (totalRedemptionsUsd + getTotalPositionValue());
        
        uint256 usdcToRepay = (totalUsdcBorrowed * redemptionRatio) / 1e18;
        uint256 ethToWithdraw = convertUsdToEth(netUsdValue);
        
        // Close portion of Hyperliquid position
        if (isHyperliquidPositionOpen) {
            (uint256 usdcReturned, int256 pnl) = IHyperliquid(hyperliquidAddress).closePosition(address(this));
            totalHyperliquidCollateral = totalHyperliquidCollateral > usdcReturned ? totalHyperliquidCollateral - usdcReturned : 0;
            hyperliquidPositionSize = 0;
            isHyperliquidPositionOpen = false;
            
            emit PositionClosed(usdcReturned, pnl, block.timestamp);
            
            // If there's still a position remaining, reopen it with reduced size
            // (This is simplified - in production might use partial closes)
        }
        
        // Repay USDC to Aave
        if (usdcToRepay > 0 && totalUsdcBorrowed >= usdcToRepay) {
            IERC20(usdcAddress).approve(aavePoolAddress, usdcToRepay);
            IPool(aavePoolAddress).repay(usdcAddress, usdcToRepay, 2, address(this));
            totalUsdcBorrowed -= usdcToRepay;
        }
        
        // Withdraw ETH from Aave
        if (ethToWithdraw > 0) {
            IPool(aavePoolAddress).withdraw(address(0), ethToWithdraw, address(this));
        }
        
        emit BulkRedemptionProcessed(ethToWithdraw, usdcToRepay, block.timestamp);
    }
    
    /**
     * @dev Distribute KashEth to depositors after batch processing
     */
    function distributeKashEths(uint256 batchCycle) internal {
        address[] memory contributors = batchContributors[batchCycle];
        uint256 ethPrice = getLatestEthPrice();
        
        for (uint256 i = 0; i < contributors.length; i++) {
            address user = contributors[i];
            uint256 totalUsdContribution = 0;
            
            // Sum all asset contributions for this user in this batch
            for (uint256 j = 0; j < supportedAssets.length; j++) {
                AssetType assetType = supportedAssets[j];
                uint256 amount = userBatchContributions[user][batchCycle][assetType];
                if (amount > 0) {
                    totalUsdContribution += convertAssetToUsd(assetType, amount);
                    userBatchContributions[user][batchCycle][assetType] = 0;
                }
            }
            
            if (totalUsdContribution > 0) {
                // Mint KashEth 1:1 with USD value (KashEth pegged to $1)
                uint256 kashEthAmount = totalUsdContribution / 1e12; // Convert to 6 decimals for KashEth
                kashEth.mint(user, kashEthAmount);
                
                emit KashEthMinted(user, address(0), 0, kashEthAmount, block.timestamp, batchCycle);
            }
            
            isContributorInBatch[batchCycle][user] = false;
        }
        
        delete batchContributors[batchCycle];
    }
    
    /**
     * @dev Distribute redeemed assets to users
     */
    function distributeRedeemedAssets(uint256 batchCycle) internal {
        address[] memory redeemers = batchRedeemers[batchCycle];
        uint256 ethPrice = getLatestEthPrice();
        
        for (uint256 i = 0; i < redeemers.length; i++) {
            address user = redeemers[i];
            uint256 kashEthAmount = pendingRedemptionsPerBatch[user][batchCycle];
            
            if (kashEthAmount > 0) {
                // Calculate USD value (KashEth is $1 pegged)
                uint256 usdValue = kashEthAmount * 1e12; // Convert from 6 decimals to 18
                
                // Add prorated fees
                int256 fees = userCumulativeFeesEarned[user];
                uint256 finalUsdValue = usdValue;
                
                if (fees > 0) {
                    finalUsdValue += uint256(fees);
                    userCumulativeFeesEarned[user] = 0;
                } else if (fees < 0) {
                    uint256 feeDeduction = uint256(-fees);
                    finalUsdValue = finalUsdValue > feeDeduction ? finalUsdValue - feeDeduction : 0;
                    userCumulativeFeesEarned[user] = 0;
                }
                
                // Convert USD to ETH and send
                uint256 ethToSend = (finalUsdValue * 1e18) / ethPrice;
                
                if (address(this).balance >= ethToSend && ethToSend > 0) {
                    payable(user).transfer(ethToSend);
                    kashEth.burn(address(this), kashEthAmount);
                    emit AssetDistributedToUser(user, address(0), ethToSend);
                }
                
                pendingRedemptionsPerBatch[user][batchCycle] = 0;
            }
        }
        
        totalRedemptionRequestsPerBatch[batchCycle] = 0;
        delete batchRedeemers[batchCycle];
    }
    
    /**
     * @dev Calculate and distribute daily fees
     */
    function calculateDailyFees(uint256 dayOrTimestamp) internal {
        int256 netFees = dailyNetFeesEarned[dayOrTimestamp];
        if (netFees == 0) return;
        
        uint256 batchCycle = dayOrTimestamp * 1 days;
        uint256 totalContrib = 0;
        
        // Calculate total USD contributions for this batch
        for (uint256 j = 0; j < supportedAssets.length; j++) {
            totalContrib += totalBatchContributions[batchCycle][supportedAssets[j]];
        }
        
        if (totalContrib == 0) return;
        
        // Store fee snapshot
        historicalFeeSnapshots[dayOrTimestamp] = FeeSnapshot({
            netFees: netFees,
            totalBatchContributions: totalContrib,
            batchCycleTimestamp: batchCycle,
            isDistributed: false
        });
        
        // Distribute to users in batches
        uint256 totalDepositors = allDepositors.length;
        if (totalDepositors > 0) {
            for (uint256 startIndex = 0; startIndex < totalDepositors; startIndex += depositorsPerFeeBatch) {
                uint256 endIndex = startIndex + depositorsPerFeeBatch - 1;
                if (endIndex >= totalDepositors) {
                    endIndex = totalDepositors - 1;
                }
                _distributeFeesToRange(dayOrTimestamp, startIndex, endIndex);
            }
        }
        
        historicalFeeSnapshots[dayOrTimestamp].isDistributed = true;
        emit DailyFeesDistributed(dayOrTimestamp, netFees, totalContrib);
    }
    
    function _distributeFeesToRange(uint256 dayOrTimestamp, uint256 startIndex, uint256 endIndex) internal {
        FeeSnapshot memory snapshot = historicalFeeSnapshots[dayOrTimestamp];
        
        for (uint256 i = startIndex; i <= endIndex && i < allDepositors.length; i++) {
            address user = allDepositors[i];
            if (!hasClaimed[user][dayOrTimestamp]) {
                uint256 userShare = getUserShareOfFees(user);
                if (userShare > 0) {
                    int256 userFeeShare = (snapshot.netFees * int256(userShare)) / 1e18;
                    userCumulativeFeesEarned[user] += userFeeShare;
                    hasClaimed[user][dayOrTimestamp] = true;
                }
            }
        }
    }
    
    // ============ View Functions ============
    
    function calculateNetBatchValue(uint256 batchCycle) public view returns (int256 netUsdValue, uint256 totalDepositsUsd, uint256 totalRedemptionsUsd) {
        // Calculate total deposits in USD
        for (uint256 j = 0; j < supportedAssets.length; j++) {
            AssetType assetType = supportedAssets[j];
            uint256 assetAmount = totalBatchContributions[batchCycle][assetType];
            if (assetAmount > 0) {
                totalDepositsUsd += convertAssetToUsd(assetType, assetAmount);
            }
        }
        
        // Calculate redemptions in USD (KashEth is $1 pegged)
        totalRedemptionsUsd = totalRedemptionRequestsPerBatch[batchCycle] * 1e12; // Convert 6 decimals to 18
        
        netUsdValue = int256(totalDepositsUsd) - int256(totalRedemptionsUsd);
    }
    
    function getUserShareOfFees(address user) public view returns (uint256) {
        uint256 totalDeposited = 0;
        for (uint256 i = 0; i < allDepositors.length; i++) {
            totalDeposited += userTotalUsdDeposited[allDepositors[i]];
        }
        if (totalDeposited == 0) return 0;
        return (userTotalUsdDeposited[user] * 1e18) / totalDeposited;
    }
    
    function getTotalPositionValue() public view returns (uint256) {
        (uint256 totalCollateral,,,,,) = IPool(aavePoolAddress).getUserAccountData(address(this));
        return totalCollateral;
    }
    
    function getLatestEthPrice() public view returns (uint256) {
        (, int256 price,,,) = IChainlinkPriceFeed(priceFeedAddress).latestRoundData();
        require(price > 0, "Invalid price");
        uint8 priceDecimals = IChainlinkPriceFeed(priceFeedAddress).decimals();
        return uint256(price) * (10 ** (18 - priceDecimals));
    }
    
    function convertAssetToUsd(AssetType assetType, uint256 amount) public view returns (uint256) {
        uint256 ethPrice = getLatestEthPrice();
        
        if (assetType == AssetType.ETH || assetType == AssetType.WETH) {
            return (amount * ethPrice) / 1e18;
        } else if (assetType == AssetType.WBTC) {
            // Would need BTC price feed in production
            uint256 btcPrice = ethPrice * 15; // Simplified assumption
            return (amount * btcPrice) / 1e8; // WBTC has 8 decimals
        } else if (assetType == AssetType.USDT || assetType == AssetType.USDC) {
            return amount * 1e12; // Convert from 6 decimals to 18
        }
        return 0;
    }
    
    function convertUsdToEth(uint256 usdAmount) public view returns (uint256) {
        uint256 ethPrice = getLatestEthPrice();
        return (usdAmount * 1e18) / ethPrice;
    }
    
    function getNextMidnightTimestamp() public view returns (uint256) {
        uint256 secondsPerDay = 86400;
        return ((block.timestamp / secondsPerDay) + 1) * secondsPerDay;
    }
    
    function isWithinTransactionWindow() public view returns (bool) {
        uint256 secondsPerDay = 86400;
        uint256 currentTimeOfDay = block.timestamp % secondsPerDay;
        uint256 windowStart = (startHourHKT * 3600) + (startMinuteHKT * 60);
        uint256 windowEnd = (endHourHKT * 3600) + (endMinuteHKT * 60);
        return currentTimeOfDay >= windowStart && currentTimeOfDay <= windowEnd;
    }
    
    function isMidnightProcessingTime() public view returns (bool) {
        uint256 timeOffset = 30 * 60; // 30 min offset
        uint256 secondsPerDay = 86400;
        uint256 currentTimeAdjusted = (block.timestamp + timeOffset) % secondsPerDay;
        return currentTimeAdjusted <= 5 * 60; // First 5 minutes of day
    }
    
    function recordDailyMetrics(uint256 dayOrTimestamp) internal {
        (uint256 totalCollateral, uint256 totalDebt,,,,) = IPool(aavePoolAddress).getUserAccountData(address(this));
        
        dailyTotalCollateral[dayOrTimestamp] = totalCollateral;
        dailyUsdcDebt[dayOrTimestamp] = totalDebt;
        
        // Get Hyperliquid funding
        int256 funding = IHyperliquid(hyperliquidAddress).getPositionFunding(address(this));
        dailyHyperliquidFunding[dayOrTimestamp] = funding;
        
        // Calculate net fees (simplified - would need actual yield calculation)
        int256 netFees = int256(totalCollateral) - int256(totalDebt) + funding;
        dailyNetFeesEarned[dayOrTimestamp] = netFees;
        
        emit DailyMetricsRecorded(dayOrTimestamp, totalCollateral, totalDebt, funding, netFees);
    }
    
    // ============ Receive Function ============
    
    receive() external payable {}
}
