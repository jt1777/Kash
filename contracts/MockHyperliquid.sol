// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import '@openzeppelin/contracts/token/ERC20/IERC20.sol';

/**
 * @title MockHyperliquid
 * @dev Mock for Hyperliquid supporting both USDC and USDT as collateral/quote.
 * - Deposit/withdraw spot using USDC or USDT
 * - Spot trading: ETH ↔ USDC/USDT, wBTC ↔ USDC/USDT
 * - Perp trading on ETH and BTC
 * All stablecoin balances are treated as equivalent (1:1 peg assumed).
 */
contract MockHyperliquid {
    address public usdcAddress; // USDC (6 decimals)
    address public usdtAddress; // USDT (6 decimals)
    address public wbtcAddress; // Optional, for future use

    // Mock prices in USD (18 decimals)
    uint256 public ethPriceUsd = 3000 * 10**18;  // $3000
    uint256 public btcPriceUsd = 60000 * 10**18; // $60000

    // Spot balances: total stablecoin balance per user (6 decimals, USDT/USDC combined)
    mapping(address => uint256) public spotBalances;

    // Perp positions: user => assetId (0=ETH, 1=BTC) => Position
    mapping(address => mapping(uint256 => Position)) public perpPositions;

    struct Position {
        uint256 size;       // Position size in asset units (18 decimals)
        uint256 collateral; // Collateral in stablecoin units (6 decimals)
        uint256 entryPrice; // Entry price in USD (18 decimals)
        bool isLong;
        bool isActive;
    }

    event SpotDeposited(address indexed user, address token, uint256 amount);
    event SpotWithdrawn(address indexed user, address token, uint256 amount);
    event SpotSwapped(address indexed user, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut);
    event PerpPositionOpened(address indexed user, string symbol, uint256 size, uint256 collateral, bool isLong, uint256 entryPrice);
    event PerpPositionClosed(address indexed user, string symbol, int256 pnl, uint256 collateralReturned);

    constructor(address _usdcAddress, address _usdtAddress, address _wbtcAddress) {
        usdcAddress = _usdcAddress;
        usdtAddress = _usdtAddress;
        wbtcAddress = _wbtcAddress;
    }

    // ========================
    // SPOT WALLET: DEPOSIT / WITHDRAW (USDC or USDT)
    // ========================

    function depositToSpotWallet(address stableToken, uint256 amount) external {
        require(amount > 0, "Amount must be > 0");
        require(stableToken == usdcAddress || stableToken == usdtAddress, "Invalid stablecoin");

        bool success = IERC20(stableToken).transferFrom(msg.sender, address(this), amount);
        require(success, "Transfer failed");

        spotBalances[msg.sender] += amount;
        emit SpotDeposited(msg.sender, stableToken, amount);
    }

    function withdrawFromSpotWallet(address stableToken, uint256 amount) external {
        require(amount > 0, "Amount must be > 0");
        require(stableToken == usdcAddress || stableToken == usdtAddress, "Invalid stablecoin");
        require(spotBalances[msg.sender] >= amount, "Insufficient spot balance");

        spotBalances[msg.sender] -= amount;
        bool success = IERC20(stableToken).transfer(msg.sender, amount);
        require(success, "Transfer failed");

        emit SpotWithdrawn(msg.sender, stableToken, amount);
    }

    // ========================
    // SPOT TRADING: ETH ↔ USDC/USDT, wBTC ↔ USDC/USDT
    // ========================

    /**
     * @notice Trade spot using either USDC or USDT as quote
     * @param tokenIn  Input: address(0)=ETH, wbtcAddress, usdcAddress, or usdtAddress
     * @param tokenOut Output
     * @param amountIn Amount of tokenIn
     * @return amountOut Amount received
     */
    function tradeSpot(address tokenIn, address tokenOut, uint256 amountIn) external returns (uint256 amountOut) {
        require(amountIn > 0, "Amount must be > 0");

        bool isStableIn = (tokenIn == usdcAddress || tokenIn == usdtAddress);
        bool isStableOut = (tokenOut == usdcAddress || tokenOut == usdtAddress);
        bool isAssetIn = (tokenIn == address(0) || tokenIn == wbtcAddress);
        bool isAssetOut = (tokenOut == address(0) || tokenOut == wbtcAddress);

        require((isStableIn && isAssetOut) || (isAssetIn && isStableOut), "Invalid pair");

        uint256 price = (tokenIn == address(0) || tokenOut == address(0)) ? ethPriceUsd : btcPriceUsd;

        if (isStableIn) {
            // Buying ETH or wBTC with stablecoin
            require(spotBalances[msg.sender] >= amountIn, "Insufficient stable balance");
            spotBalances[msg.sender] -= amountIn;

            uint256 usdValue18 = amountIn * 10**12;
            amountOut = (usdValue18 * 10**18) / price;

            if (tokenOut == address(0)) {
                payable(msg.sender).transfer(amountOut);
            }
            // For wBTC: would transfer mock wBTC if implemented
        } else {
            // Selling ETH or wBTC for stablecoin
            uint256 usdValue18 = (amountIn * price) / 10**18;
            amountOut = usdValue18 / 10**12;

            spotBalances[msg.sender] += amountOut;

            // Choose which stable to return (prefer USDC if available, else USDT)
            address returnToken = (tokenOut == usdcAddress) ? usdcAddress : usdtAddress;
            // In real impl, could let user choose — here fixed to tokenOut if specified

            // If tokenOut is specific stable, use it; else default to USDC
            if (tokenOut != usdcAddress && tokenOut != usdtAddress) {
                returnToken = usdcAddress;
            } else {
                returnToken = tokenOut;
            }

            // Contract receives ETH when selling ETH
            if (tokenIn == address(0)) {
                // In tests: send ETH to contract before calling
            }
        }

        emit SpotSwapped(msg.sender, tokenIn, tokenOut, amountIn, amountOut);
        return amountOut;
    }

    // ========================
    // PERP TRADING (unchanged logic, uses spotBalances)
    // ========================

    function openPerpPosition(string memory symbol, uint256 size, bool isLong) external {
        require(size > 0, "Size must be > 0");
        bytes32 symHash = keccak256(bytes(symbol));
        require(symHash == keccak256("ETH") || symHash == keccak256("BTC"), "Only ETH/BTC");

        uint256 assetId = symHash == keccak256("ETH") ? 0 : 1;
        require(!perpPositions[msg.sender][assetId].isActive, "Position active");

        uint256 price = assetId == 0 ? ethPriceUsd : btcPriceUsd;
        uint256 collateralUsd18 = (size * price) / 10**18 / 10; // ~10x leverage
        uint256 collateralStable = collateralUsd18 / 10**12;

        require(spotBalances[msg.sender] >= collateralStable, "Insufficient collateral");
        spotBalances[msg.sender] -= collateralStable;

        perpPositions[msg.sender][assetId] = Position({
            size: size,
            collateral: collateralStable,
            entryPrice: price,
            isLong: isLong,
            isActive: true
        });

        emit PerpPositionOpened(msg.sender, symbol, size, collateralStable, isLong, price);
    }

    function closePerpPosition(string memory symbol) external {
        bytes32 symHash = keccak256(bytes(symbol));
        require(symHash == keccak256("ETH") || symHash == keccak256("BTC"), "Only ETH/BTC");

        uint256 assetId = symHash == keccak256("ETH") ? 0 : 1;
        Position storage pos = perpPositions[msg.sender][assetId];
        require(pos.isActive, "No active position");

        uint256 exitPrice = assetId == 0 ? ethPriceUsd : btcPriceUsd;

        int256 priceDiff = int256(exitPrice) - int256(pos.entryPrice);
        int256 direction = pos.isLong ? int256(1) : int256(-1);
        int256 pnlUsd18 = (int256(pos.size) * priceDiff * direction) / int256(pos.entryPrice);
        int256 pnlStable = pnlUsd18 / int256(10**12);

        int256 finalCollateral = int256(pos.collateral) + pnlStable;
        require(finalCollateral >= 0, "Liquidated");

        uint256 returnStable = uint256(finalCollateral);
        spotBalances[msg.sender] += returnStable;

        emit PerpPositionClosed(msg.sender, symbol, pnlStable, returnStable);

        pos.isActive = false;
    }

    // ========================
    // TESTING HELPERS
    // ========================

    function setEthPrice(uint256 _price) external {
        ethPriceUsd = _price;
    }

    function setBtcPrice(uint256 _price) external {
        btcPriceUsd = _price;
    }

    function getSpotBalance(address user) external view returns (uint256) {
        return spotBalances[user];
    }

    // Allow receiving ETH for spot sales
    receive() external payable {}
}