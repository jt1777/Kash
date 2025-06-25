// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function approve(address spender, uint256 value) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/**
 * @title MockGMX
 * @dev A mock contract to simulate GMX DEX functionality for testing purposes.
 * Allows receiving USDT as collateral and simulating margin trades.
 */
contract MockGMX {
    address public usdtAddress;
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

    struct Position {
        uint256 positionId;
        address owner;
        uint256 collateralAmount; // USDT amount used as collateral
        uint256 leverage; // Leverage factor (e.g., 2 for 2x)
        uint256 entryPrice; // Mock entry price for the asset (e.g., ETH price in USD, 18 decimals)
        bool isLong; // True for long position, false for short
        bool isActive; // Whether the position is active
    }

    event CollateralDeposited(address indexed user, uint256 amount);
    event PositionOpened(uint256 indexed positionId, address indexed owner, uint256 collateral, uint256 leverage, bool isLong, uint256 entryPrice);
    event PositionClosed(uint256 indexed positionId, address indexed owner);

    constructor(address _usdtAddress) {
        usdtAddress = _usdtAddress;
    }

    // Function to deposit USDT collateral and open a margin trade with custom position size
    function depositCollateralAndOpenPositionWithSize(uint256 collateralAmount, uint256 positionSize, bool isLong, address onBehalfOf) external {
        require(collateralAmount > 0, "Collateral amount must be greater than 0");
        require(positionSize >= collateralAmount, "Position size must be at least collateral amount");
        // Transfer USDT from the sender to this contract
        bool success = IERC20(usdtAddress).transferFrom(msg.sender, address(this), collateralAmount);
        require(success, "USDT transfer failed");
        
        collateralBalances[onBehalfOf] += collateralAmount;
        totalCollateral += collateralAmount;
        emit CollateralDeposited(onBehalfOf, collateralAmount);
        
        // Simulate opening a margin trade with specified position size
        // Calculate leverage as positionSize / collateralAmount
        uint256 leverage = (positionSize * 1e18) / collateralAmount; // Use 18 decimals for precision
        // For simplicity, assume entry price is $2,000 for ETH (with 18 decimals for calculation)
        uint256 mockEntryPrice = 2000 * 10**18;
        positionCounter++;
        positions[onBehalfOf] = Position({
            positionId: positionCounter,
            owner: onBehalfOf,
            collateralAmount: collateralAmount,
            leverage: leverage / 1e18, // Store as whole number
            entryPrice: mockEntryPrice,
            isLong: isLong,
            isActive: true
        });
        emit PositionOpened(positionCounter, onBehalfOf, collateralAmount, leverage / 1e18, isLong, mockEntryPrice);
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
        // For simplicity, assume entry price is $2,000 for ETH (with 18 decimals for calculation)
        uint256 mockEntryPrice = 2000 * 10**18;
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
        emit PositionOpened(positionCounter, onBehalfOf, amount, defaultLeverage, isLong, mockEntryPrice);
    }

    // Function to close a position and return collateral (simplified, no P/L calculation)
    function closePosition(address onBehalfOf) external {
        Position storage position = positions[onBehalfOf];
        require(position.isActive, "No active position for this address");
        require(position.owner == onBehalfOf, "Invalid position owner");
        
        uint256 collateralToReturn = position.collateralAmount;
        collateralBalances[onBehalfOf] -= collateralToReturn;
        totalCollateral -= collateralToReturn;
        position.isActive = false;
        emit PositionClosed(position.positionId, onBehalfOf);
        
        // Return collateral to the owner (in a real scenario, adjust for profit/loss)
        bool success = IERC20(usdtAddress).transfer(onBehalfOf, collateralToReturn);
        require(success, "USDT return transfer failed");
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

    // Function to update default leverage for testing
    function setDefaultLeverage(uint256 _leverage) external {
        require(_leverage > 0, "Leverage must be greater than 0");
        defaultLeverage = _leverage;
    }
} 