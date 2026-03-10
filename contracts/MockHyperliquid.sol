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
    mapping(address => uint256) public ethBalance; // 18 decimals, from spot buy
    mapping(address => uint256) public btcBalance;

    // Perp positions: user => assetId (0=ETH, 1=BTC) => Position
    mapping(address => mapping(uint256 => Position)) public perpPositions;

    struct Position {
        uint256 size;       // Position size in asset units (18 decimals)
        uint256 collateral; // Collateral in stablecoin units (6 decimals)
        uint256 entryPrice; // Entry price in USD (18 decimals)
        uint256 openTimestamp; // When position was opened (for funding)
        bool isLong;
        bool isActive;
    }

    // Funding rate per day in basis points. Positive = shorts receive funding. E.g. 10 = 0.1% per day.
    int256 public fundingRatePerDayBps = 10;

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
     * @notice Trade spot. Payable when selling ETH (send value). Buy credits internal eth/btc balance.
     */
    function tradeSpot(address tokenIn, address tokenOut, uint256 amountIn) external payable returns (uint256 amountOut) {
        require(amountIn > 0, "Amount must be > 0");

        bool isStableIn = (tokenIn == usdcAddress || tokenIn == usdtAddress);
        bool isStableOut = (tokenOut == usdcAddress || tokenOut == usdtAddress);
        bool isAssetIn = (tokenIn == address(0) || tokenIn == wbtcAddress);
        bool isAssetOut = (tokenOut == address(0) || tokenOut == wbtcAddress);

        require((isStableIn && isAssetOut) || (isAssetIn && isStableOut), "Invalid pair");

        uint256 price = (tokenIn == address(0) || tokenOut == address(0)) ? ethPriceUsd : btcPriceUsd;

        if (isStableIn) {
            require(spotBalances[msg.sender] >= amountIn, "Insufficient stable balance");
            spotBalances[msg.sender] -= amountIn;
            uint256 usdValue18 = amountIn * 10**12;
            amountOut = (usdValue18 * 10**18) / price;
            if (tokenOut == address(0)) {
                ethBalance[msg.sender] += amountOut;
            } else {
                btcBalance[msg.sender] += amountOut;
            }
        } else {
            if (tokenIn == address(0)) {
                require(ethBalance[msg.sender] >= amountIn || msg.value >= amountIn, "Insufficient ETH");
                if (ethBalance[msg.sender] >= amountIn) {
                    ethBalance[msg.sender] -= amountIn;
                } else {
                    require(msg.value >= amountIn, "ETH amount must match");
                    if (msg.value > amountIn) {
                        payable(msg.sender).transfer(msg.value - amountIn);
                    }
                }
            } else {
                require(btcBalance[msg.sender] >= amountIn, "Insufficient BTC balance");
                btcBalance[msg.sender] -= amountIn;
            }
            uint256 usdValue18 = (amountIn * price) / 10**18;
            amountOut = usdValue18 / 10**12;
            spotBalances[msg.sender] += amountOut;
        }

        emit SpotSwapped(msg.sender, tokenIn, tokenOut, amountIn, amountOut);
        return amountOut;
    }

    // ========================
    // PERP TRADING (unchanged logic, uses spotBalances)
    // ========================

    /// @notice Open a new perp position or add to an existing one (same symbol and direction).
    function openPerpPosition(string memory symbol, uint256 size, bool isLong) external {
        require(size > 0, "Size must be > 0");
        bytes32 symHash = keccak256(bytes(symbol));
        require(symHash == keccak256("ETH") || symHash == keccak256("BTC"), "Only ETH/BTC");

        uint256 assetId = symHash == keccak256("ETH") ? 0 : 1;
        Position storage pos = perpPositions[msg.sender][assetId];

        uint256 price = assetId == 0 ? ethPriceUsd : btcPriceUsd;
        uint256 collateralUsd18 = (size * price) / 10**18 / 10;
        uint256 collateralStable = collateralUsd18 / 10**12;
        uint256 collateralAsset = size / 10;

        if (pos.isActive) {
            require(pos.isLong == isLong, "Cannot add opposite direction");
            // Add to existing position: pull collateral for new size
            if (assetId == 0) {
                if (ethBalance[msg.sender] >= collateralAsset) {
                    ethBalance[msg.sender] -= collateralAsset;
                } else {
                    require(spotBalances[msg.sender] >= collateralStable, "Insufficient collateral");
                    spotBalances[msg.sender] -= collateralStable;
                }
            } else {
                if (btcBalance[msg.sender] >= collateralAsset) {
                    btcBalance[msg.sender] -= collateralAsset;
                } else {
                    require(spotBalances[msg.sender] >= collateralStable, "Insufficient collateral");
                    spotBalances[msg.sender] -= collateralStable;
                }
            }
            // VWAP entry price
            uint256 oldSize = pos.size;
            uint256 oldCollateral = pos.collateral;
            uint256 oldEntry = pos.entryPrice;
            pos.entryPrice = (oldSize * oldEntry + size * price) / (oldSize + size);
            pos.size = oldSize + size;
            pos.collateral = oldCollateral + collateralStable;
            emit PerpPositionOpened(msg.sender, symbol, size, collateralStable, isLong, price);
            return;
        }

        // New position
        if (assetId == 0) {
            if (ethBalance[msg.sender] >= collateralAsset) {
                ethBalance[msg.sender] -= collateralAsset;
            } else {
                require(spotBalances[msg.sender] >= collateralStable, "Insufficient collateral");
                spotBalances[msg.sender] -= collateralStable;
            }
        } else {
            if (btcBalance[msg.sender] >= collateralAsset) {
                btcBalance[msg.sender] -= collateralAsset;
            } else {
                require(spotBalances[msg.sender] >= collateralStable, "Insufficient collateral");
                spotBalances[msg.sender] -= collateralStable;
            }
        }

        perpPositions[msg.sender][assetId] = Position({
            size: size,
            collateral: collateralStable,
            entryPrice: price,
            openTimestamp: block.timestamp,
            isLong: isLong,
            isActive: true
        });

        emit PerpPositionOpened(msg.sender, symbol, size, collateralStable, isLong, price);
    }

    /// @notice Close entire perp position (backward compatible).
    function closePerpPosition(string memory symbol) external {
        uint256 assetId = _symbolToAssetId(symbol);
        Position storage pos = perpPositions[msg.sender][assetId];
        require(pos.isActive, "No active position");
        _closePerpPosition(symbol, assetId, pos.size);
    }

    /// @notice Close part or all of a perp position. If closeSize >= position size, closes fully.
    function closePerpPosition(string memory symbol, uint256 closeSize) external {
        uint256 assetId = _symbolToAssetId(symbol);
        Position storage pos = perpPositions[msg.sender][assetId];
        require(pos.isActive, "No active position");
        uint256 sizeToClose = closeSize >= pos.size ? pos.size : closeSize;
        require(sizeToClose > 0, "Close size must be > 0");
        _closePerpPosition(symbol, assetId, sizeToClose);
    }

    function _symbolToAssetId(string memory symbol) internal pure returns (uint256) {
        bytes32 symHash = keccak256(bytes(symbol));
        require(symHash == keccak256("ETH") || symHash == keccak256("BTC"), "Only ETH/BTC");
        return symHash == keccak256("ETH") ? 0 : 1;
    }

    function _closePerpPosition(string memory symbol, uint256 assetId, uint256 closeSize) internal {
        Position storage pos = perpPositions[msg.sender][assetId];
        require(closeSize <= pos.size && closeSize > 0, "Invalid close size");

        uint256 exitPrice = assetId == 0 ? ethPriceUsd : btcPriceUsd;
        uint256 posSize = pos.size;
        uint256 posCollateral = pos.collateral;
        uint256 posEntry = pos.entryPrice;

        // Proportional PnL and collateral for the closed portion
        int256 priceDiff = int256(exitPrice) - int256(posEntry);
        int256 direction = pos.isLong ? int256(1) : int256(-1);
        int256 pnlUsd18 = (int256(closeSize) * priceDiff * direction) / int256(posEntry);
        int256 pnlStable = pnlUsd18 / int256(10**12);
        uint256 collateralReturn = (posCollateral * closeSize) / posSize;
        int256 finalCollateral = int256(collateralReturn) + pnlStable;
        require(finalCollateral >= 0, "Liquidated");

        uint256 collateralAsset = closeSize / 10;
        if (assetId == 0) {
            ethBalance[msg.sender] += collateralAsset;
        } else {
            btcBalance[msg.sender] += collateralAsset;
        }
        if (pnlStable > 0) {
            spotBalances[msg.sender] += uint256(pnlStable);
        }

        emit PerpPositionClosed(msg.sender, symbol, pnlStable, uint256(finalCollateral));

        if (closeSize >= posSize) {
            pos.isActive = false;
            pos.size = 0;
            pos.collateral = 0;
        } else {
            pos.size = posSize - closeSize;
            pos.collateral = posCollateral - collateralReturn;
        }
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

    /// @notice Get perp position for a user and symbol (for KashYieldETH / adapter interface).
    function getPosition(address user, string calldata symbol) external view returns (
        uint256 size,
        uint256 collateral,
        uint256 entryPrice,
        bool isLong,
        bool isActive
    ) {
        bytes32 symHash = keccak256(bytes(symbol));
        if (symHash != keccak256("ETH") && symHash != keccak256("BTC")) {
            return (0, 0, 0, false, false);
        }
        uint256 assetId = symHash == keccak256("ETH") ? 0 : 1;
        Position storage pos = perpPositions[user][assetId];
        return (pos.size, pos.collateral, pos.entryPrice, pos.isLong, pos.isActive);
    }

    /// @notice Accrued funding in USD (18 decimals). Positive = we receive. For shorts: positive fundingRatePerDayBps => we receive.
    function getAccruedFundingUsd(address user, string calldata symbol) external view returns (int256) {
        bytes32 symHash = keccak256(bytes(symbol));
        if (symHash != keccak256("ETH") && symHash != keccak256("BTC")) return 0;
        uint256 assetId = symHash == keccak256("ETH") ? 0 : 1;
        Position storage pos = perpPositions[user][assetId];
        if (!pos.isActive || pos.openTimestamp == 0) return 0;
        uint256 positionSizeUsd = (pos.size * pos.entryPrice) / 10**18;
        uint256 daysElapsed = (block.timestamp - pos.openTimestamp) / 86400;
        if (daysElapsed == 0) return 0;
        // Shorts: positive rate => we receive (positive return). Longs: negative rate => we pay.
        int256 rate = pos.isLong ? -fundingRatePerDayBps : fundingRatePerDayBps;
        int256 fundingUsd = (int256(positionSizeUsd) * rate * int256(daysElapsed)) / 10000;
        return fundingUsd;
    }

    function setFundingRatePerDayBps(int256 _bps) external {
        fundingRatePerDayBps = _bps;
    }

    /// @notice No-op for mock (no order book). Real HL uses API for cancel.
    function cancelOrder(bytes32 /* orderId */) external {
        // Mock has no order book; no-op.
    }

    /// @notice Mock has no order book; returns empty array.
    function getOpenOrderIds(address /* account */) external pure returns (bytes32[] memory) {
        return new bytes32[](0);
    }

    // Allow receiving ETH for spot sales
    receive() external payable {}
}