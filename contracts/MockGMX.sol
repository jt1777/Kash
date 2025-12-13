// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;

import '@openzeppelin/contracts/token/ERC20/IERC20.sol';

// Interface for Chainlink price feed to get ETH/USD price
interface IChainlinkPriceFeed {
    function latestRoundData() external view returns (
        uint80 roundId,
        int256 answer,
        uint256 startedAt,
        uint256 updatedAt,
        uint80 answeredInRound
    );
    function decimals() external view returns (uint8);
}

/**
 * @title MockGMX
 * @dev A mock contract to simulate GMX DEX functionality for testing purposes.
 * Allows receiving USDT as collateral, simulating margin trades, swaps using Chainlink ETH price, and P/L calculation on position close.
 */
contract MockGMX {
    address public usdtAddress;
    address public chainlinkPriceFeedAddress;
    // Mapping to track collateral deposited by each address (in USDT)
    mapping(address => uint256) public collateralBalances;
    // Mapping to track open positions (address => position details)
    mapping(address => Position) public positions;
    // Total USDT collateral received by the contract
    uint256 public totalCollateral;
    // Mock leverage factor for positions (default 2x for simplicity)
    uint256 public defaultLeverage = 2;
    // Mock position counter for unique position IDs
    uint256 public positionCounter = 0;
    // Mock funding rate per day for short positions (in basis points, adjustable)
    int256 public fundingRatePerDayBps = 10; // 0.1% per day as default, positive for shorts earning funding
    // Mapping to track last funding update timestamp for each position
    mapping(address => uint256) public lastFundingUpdate;
    // Mapping to store funding amounts for testing purposes
    mapping(address => int256) public fundingAmounts;
    // Mapping to track short positions (address => short position details)
    mapping(address => ShortPosition) public shortPositions;

    struct Position {
        uint256 positionId;
        address owner;
        uint256 collateralAmount; // USDT amount used as collateral
        uint256 leverage; // Leverage factor (e.g., 2 for 2x)
        uint256 entryPrice; // Mock entry price for the asset (e.g., ETH price in USD, 18 decimals)
        bool isLong; // True for long position, false for short
        bool isActive; // Whether the position is active
    }

    struct ShortPosition {
        uint256 collateralEth; // Collateral in ETH terms
        uint256 sizeEth; // Size of the position in ETH terms
        bool isActive; // Whether the position is active
        bool isLong; // Whether it's a long position
    }

    event CollateralDeposited(address indexed user, uint256 amount);
    event PositionOpened(uint256 indexed positionId, address indexed owner, uint256 collateral, uint256 leverage, bool isLong, uint256 entryPrice);
    event PositionClosed(uint256 indexed positionId, address indexed owner, int256 profitLoss, uint256 collateralReturned);
    event DebugLog(string message, uint256 value);
    event ShortPositionOpened(address indexed account, uint256 collateralEth, uint256 sizeEth, bool isLong);
    event SwapExecuted(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut);

    constructor(address _usdtAddress, address _chainlinkPriceFeedAddress) {
        usdtAddress = _usdtAddress;
        chainlinkPriceFeedAddress = _chainlinkPriceFeedAddress;
    }

    // Function to deposit USDT collateral and open a margin trade with custom position size
    function depositCollateralAndOpenPositionWithSize(uint256 amount, uint256 positionSize, bool isLong, address onBehalfOf) external {
        require(amount > 0, "Collateral amount must be greater than 0");
        require(positionSize > 0, "Position size must be greater than 0");
        require(!isLong, "Only short positions are supported");
        // Simulate opening a short position with specified size
        shortPositions[onBehalfOf] = ShortPosition({
            collateralEth: amount,
            sizeEth: positionSize,
            isActive: true,
            isLong: isLong
        });
        lastFundingUpdate[onBehalfOf] = block.timestamp; // Add this to set funding timestamp
        emit ShortPositionOpened(onBehalfOf, amount, positionSize, isLong);
        emit DebugLog("Short position opened with size", positionSize);
        emit DebugLog("Collateral provided", amount);
    }

    // Maintain the original function for backward compatibility
    function depositCollateralAndOpenPosition(uint256 amount, bool isLong, address onBehalfOf) external {
        require(amount > 0, "Collateral amount must be greater than 0");
        // Transfer USDT from the sender to this contract
        bool success = IERC20(usdtAddress).transferFrom(msg.sender, address(this), amount);
        require(success, "USDT transfer failed");
        
        collateralBalances[onBehalfOf] += amount;
        totalCollateral += amount;
        emit CollateralDeposited(onBehalfOf, amount);
        
        // Simulate opening a margin trade with default leverage
        // Get current ETH price from Chainlink feed as entry price
        uint256 mockEntryPrice = getLatestEthPrice();
        positionCounter++;
        positions[onBehalfOf] = Position({
            positionId: positionCounter,
            owner: onBehalfOf,
            collateralAmount: amount,
            leverage: defaultLeverage,
            entryPrice: mockEntryPrice,
            isLong: isLong,
            isActive: true
        });
        lastFundingUpdate[onBehalfOf] = block.timestamp; // Initialize funding update timestamp
        emit PositionOpened(positionCounter, onBehalfOf, amount, defaultLeverage, isLong, mockEntryPrice);
    }

    // Function to close a position and return collateral (with P/L calculation)
    function closePosition(address onBehalfOf) external {
        // First check if there's a short position
        ShortPosition storage shortPosition = shortPositions[onBehalfOf];
        if (shortPosition.isActive) {
            // Close short position
            uint256 shortCollateralToReturn = shortPosition.collateralEth;
            shortPosition.isActive = false;
            lastFundingUpdate[onBehalfOf] = block.timestamp;
            emit DebugLog("Short position closed", shortCollateralToReturn);
            
            // Return collateral in ETH
            payable(onBehalfOf).transfer(shortCollateralToReturn);
            return;
        }
        
        // Fall back to regular position logic
        Position storage position = positions[onBehalfOf];
        require(position.isActive, "No active position for this address");
        require(position.owner == onBehalfOf, "Invalid position owner");
        
        uint256 collateralToReturn = position.collateralAmount;
        // Calculate profit/loss based on entry and exit price
        uint256 exitPrice = getLatestEthPrice();
        int256 profitLoss = calculateProfitLoss(position.entryPrice, exitPrice, position.collateralAmount, position.leverage, position.isLong);
        
        // Adjust collateral to return based on P/L
        int256 adjustedCollateral = int256(collateralToReturn) + profitLoss;
        require(adjustedCollateral >= 0, "Position loss exceeds collateral, cannot close");
        collateralToReturn = uint256(adjustedCollateral);
        
        collateralBalances[onBehalfOf] -= position.collateralAmount; // Reduce by original collateral
        totalCollateral -= position.collateralAmount;
        position.isActive = false;
        lastFundingUpdate[onBehalfOf] = block.timestamp; // Update timestamp on close
        emit PositionClosed(position.positionId, onBehalfOf, profitLoss, collateralToReturn);
        
        // Return adjusted collateral to the owner in ETH instead of USDT
        payable(onBehalfOf).transfer(collateralToReturn);
    }

    // Function to get collateral balance for a user
    function getCollateralBalance(address user) external view returns (uint256) {
        return collateralBalances[user];
    }

    // Function to get position details for a user
    function getPosition(address user) external view returns (uint256 positionId, uint256 collateralAmount, uint256 leverage, uint256 entryPrice, bool isLong, bool isActive) {
        Position memory pos = positions[user];
         return (pos.positionId, pos.collateralAmount, pos.leverage, pos.entryPrice, pos.isLong, pos.isActive);
    }

    // Function to get short position details for a user (for testing purposes)
    function getShortPosition(address user) external view returns (ShortPosition memory) {
        return shortPositions[user];
    }

    // Function to update default leverage for testing
    function setDefaultLeverage(uint256 _leverage) external {
        require(_leverage > 0, "Leverage must be greater than 0");
        defaultLeverage = _leverage;
    }

    // Function to simulate funding fees for positions (as per IGMX interface in KashYield.sol)
    function getPositionFunding(address account, address indexToken, bool isLong) external returns (int256 fundingAmount) {
        require(indexToken == address(0), "Mock only supports ETH positions");
        
        if (fundingAmounts[account] != 0) {
            int256 amount = fundingAmounts[account];
            fundingAmounts[account] = 0; // Reset to prevent reuse
            emit DebugLog("Funding amount returned", uint256(amount));
            return amount;
        }
        
        ShortPosition memory position = shortPositions[account];
        if (!position.isActive || position.isLong != isLong) {
            emit DebugLog("No funding: inactive or type mismatch", 0);
            return 0; // No funding if no active position or type mismatch
        }
        
        // Calculate time elapsed since last funding update
        uint256 timeElapsed = block.timestamp - lastFundingUpdate[account];
        uint256 daysElapsed = timeElapsed / 1 days;
        if (daysElapsed == 0) {
            emit DebugLog("No funding: daysElapsed = 0", 0);
            return 0; // No funding if less than a day has passed
        }
        
        // Use short position size for funding calculation
        int256 ratePerDay = isLong ? -fundingRatePerDayBps : fundingRatePerDayBps;
        int256 totalFunding = (int256(position.sizeEth) * ratePerDay * int256(daysElapsed)) / 10000; // Funding in ETH terms
        emit DebugLog("Default funding calculated", uint256(totalFunding));
        return totalFunding;
    }

    // Function to update funding rate for testing purposes
    function setFundingRatePerDayBps(int256 _rateBps) external {
        fundingRatePerDayBps = _rateBps;
    }

    // Function to manually update funding timestamp for testing
    function updateFundingTimestamp(address account, uint256 timestamp) external {
        lastFundingUpdate[account] = timestamp;
    }

    // Function to set funding amount directly for testing purposes
    function setFundingAmount(address account, int256 amount) external {
        // Store the funding amount to be returned by getPositionFunding
        fundingAmounts[account] = amount;
    }

    // Function to simulate a token swap for testing purposes using Chainlink price feed
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, address recipient) external returns (uint256) {
        require(amountIn > 0, "Swap amount must be greater than 0");
        // Transfer input tokens from sender to this contract
        bool success = IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        require(success, "Token transfer failed");
        
        // Calculate output amount based on current ETH price from Chainlink
        uint256 amountOut;
        uint256 ethPrice = getLatestEthPrice(); // ETH price in USD, 18 decimals
        if (tokenIn == usdtAddress && tokenOut == address(0)) {
            // USDT to ETH: USDT (6 decimals) to ETH (18 decimals)
            // USDT amount * (1 USD/USDT) / (ETH price in USD/ETH) = ETH amount
            uint256 usdtInUsd = amountIn * 10**12; // Convert USDT 6 decimals to 18 decimals (assuming 1 USDT = 1 USD)
            amountOut = (usdtInUsd * 10**18) / ethPrice; // ETH amount in 18 decimals
        } else if (tokenIn == address(0) && tokenOut == usdtAddress) {
            // ETH to USDT: ETH (18 decimals) to USDT (6 decimals)
            // ETH amount * (ETH price in USD/ETH) = USD value, then USD / (1 USD/USDT) = USDT amount
            uint256 ethInUsd = (amountIn * ethPrice) / 10**18; // USD value in 18 decimals
            amountOut = ethInUsd / 10**12; // Convert to USDT 6 decimals
        } else {
            // Unsupported pair, fallback to 1:1 for simplicity
            amountOut = amountIn;
        }
        // Ensure output is at least minAmountOut
        require(amountOut >= minAmountOut, "Insufficient output amount");
        
        // Transfer output tokens to recipient
        if (tokenOut == address(0)) {
            // If output is ETH, use payable transfer
            payable(recipient).transfer(amountOut);
        } else {
            // Otherwise, use ERC20 transfer
            success = IERC20(tokenOut).transfer(recipient, amountOut);
            require(success, "Output token transfer failed");
        }
        
        emit SwapExecuted(tokenIn, tokenOut, amountIn, amountOut);
        emit DebugLog("Swap amount in", amountIn);
        emit DebugLog("Swap amount out", amountOut);
        return amountOut;
    }

    // Allow contract to receive ETH for testing purposes (e.g., swaps)
    receive() external payable {
        // No specific logic needed, just accept ETH
    }

    // Helper function to get the latest ETH price from Chainlink feed
    function getLatestEthPrice() public view returns (uint256) {
        (, int256 price, , , ) = IChainlinkPriceFeed(chainlinkPriceFeedAddress).latestRoundData();
        require(price > 0, "Invalid price from oracle");
        uint8 priceDecimals = IChainlinkPriceFeed(chainlinkPriceFeedAddress).decimals();
        // Convert price to 18 decimals for consistency with ETH calculations
        uint256 adjustedPrice = uint256(price) * (10 ** (18 - priceDecimals));
        return adjustedPrice; // Price adjusted to 18 decimals
    }

    // Helper function to calculate profit/loss for a position
    function calculateProfitLoss(uint256 entryPrice, uint256 exitPrice, uint256 collateralAmount, uint256 leverage, bool isLong) public pure returns (int256) {
        uint256 positionSize = collateralAmount * leverage; // Total exposure in USDT terms
        int256 priceChange = int256(exitPrice) - int256(entryPrice); // Change in ETH price (USD, 18 decimals)
        // For long: profit if price increases (exit > entry), loss if decreases
        // For short: profit if price decreases (exit < entry), loss if increases
        int256 directionMultiplier = isLong ? int256(1) : int256(-1);
        // P/L = (position size in USDT) * (price change / entry price) * direction
        // Adjust for decimals: positionSize (USDT, 6 decimals), price (18 decimals), so adjust to USDT decimals
        int256 profitLoss = (int256(positionSize) * priceChange * directionMultiplier) / int256(entryPrice);
        // Convert P/L to USDT decimals (assuming positionSize is in USDT 6 decimals, no further adjustment needed)
        return profitLoss;
    }
} 