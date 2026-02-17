// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';

/**
 * @title MockHyperliquid
 * @dev Mock contract simulating Hyperliquid perpetual DEX for testing
 * Supports ETH 1.7x short positions with USDC collateral
 */
contract MockHyperliquid {
    using SafeERC20 for IERC20;
    
    address public usdcAddress;
    address public wethAddress;
    
    struct Position {
        uint256 collateral;      // USDC collateral amount (6 decimals)
        uint256 positionSize;    // Position size in USD (18 decimals)
        uint256 entryPrice;      // Entry price of the position
        bool isLong;             // true = long, false = short
        bool isOpen;             // Whether position is active
        int256 cumulativeFunding; // Cumulative funding earned/paid
    }
    
    mapping(address => Position) public positions;
    
    // Mock funding rate (positive = shorts pay longs, negative = longs pay shorts)
    int256 public mockFundingRate = 0.0001e18; // 0.01% per day
    
    // Mock ETH price (18 decimals)
    uint256 public mockEthPrice = 3000e18;
    
    // Events
    event PositionOpened(address indexed user, uint256 collateral, uint256 positionSize, bool isLong, uint256 entryPrice);
    event PositionClosed(address indexed user, uint256 collateralReturned, int256 pnl, int256 fundingEarned);
    event CollateralDeposited(address indexed user, uint256 amount);
    event CollateralWithdrawn(address indexed user, uint256 amount);
    event FundingPaid(address indexed user, int256 amount);
    
    constructor(address _usdcAddress, address _wethAddress) {
        usdcAddress = _usdcAddress;
        wethAddress = _wethAddress;
    }
    
    /**
     * @dev Deposit USDC collateral and open a 1.7x ETH short position
     * @param usdcAmount Amount of USDC to deposit as collateral
     * @param positionSizeUsd Desired position size in USD (should be ~1.7x collateral value)
     * @param onBehalfOf Address to open position for
     */
    function depositCollateralAndOpenShort(
        uint256 usdcAmount, 
        uint256 positionSizeUsd, 
        address onBehalfOf
    ) external {
        require(usdcAmount > 0, "Collateral must be greater than 0");
        require(!positions[onBehalfOf].isOpen, "Position already open");
        
        // Transfer USDC from caller
        IERC20(usdcAddress).safeTransferFrom(msg.sender, address(this), usdcAmount);
        
        // Open short position
        positions[onBehalfOf] = Position({
            collateral: usdcAmount,
            positionSize: positionSizeUsd,
            entryPrice: mockEthPrice,
            isLong: false,
            isOpen: true,
            cumulativeFunding: 0
        });
        
        emit CollateralDeposited(onBehalfOf, usdcAmount);
        emit PositionOpened(onBehalfOf, usdcAmount, positionSizeUsd, false, mockEthPrice);
    }
    
    /**
     * @dev Close short position and return collateral + PnL
     * @param onBehalfOf Address whose position to close
     */
    function closePosition(address onBehalfOf) external returns (uint256 collateralReturned, int256 pnl) {
        Position storage pos = positions[onBehalfOf];
        require(pos.isOpen, "No open position");
        
        // Calculate PnL for short position
        // Short PnL = (entryPrice - currentPrice) * positionSize / entryPrice
        int256 priceDiff = int256(pos.entryPrice) - int256(mockEthPrice);
        pnl = (priceDiff * int256(pos.positionSize)) / int256(pos.entryPrice);
        
        // Add funding earned
        int256 fundingEarned = pos.cumulativeFunding;
        
        // Calculate total return
        int256 totalReturn = int256(pos.collateral) + pnl + fundingEarned;
        
        require(totalReturn > 0, "Position underwater");
        collateralReturned = uint256(totalReturn);
        
        // Transfer USDC back
        IERC20(usdcAddress).safeTransfer(msg.sender, collateralReturned);
        
        emit PositionClosed(onBehalfOf, collateralReturned, pnl, fundingEarned);
        
        // Clear position
        delete positions[onBehalfOf];
        
        return (collateralReturned, pnl);
    }
    
    /**
     * @dev Get position funding for an account
     */
    function getPositionFunding(address account) external view returns (int256) {
        return positions[account].cumulativeFunding;
    }
    
    /**
     * @dev Simulate accruing funding (call this to update funding)
     */
    function accrueFunding(address account) external {
        Position storage pos = positions[account];
        if (!pos.isOpen) return;
        
        // For shorts: positive funding rate = shorts receive payment
        int256 funding = (int256(pos.positionSize) * mockFundingRate) / 1e18;
        pos.cumulativeFunding += funding;
        
        emit FundingPaid(account, funding);
    }
    
    /**
     * @dev Set mock ETH price (for testing)
     */
    function setMockEthPrice(uint256 _price) external {
        mockEthPrice = _price;
    }
    
    /**
     * @dev Set mock funding rate (for testing)
     */
    function setMockFundingRate(int256 _rate) external {
        mockFundingRate = _rate;
    }
    
    /**
     * @dev Get current position info
     */
    function getPosition(address account) external view returns (
        uint256 collateral,
        uint256 positionSize,
        uint256 entryPrice,
        bool isLong,
        bool isOpen,
        int256 funding
    ) {
        Position memory pos = positions[account];
        return (pos.collateral, pos.positionSize, pos.entryPrice, pos.isLong, pos.isOpen, pos.cumulativeFunding);
    }
}
