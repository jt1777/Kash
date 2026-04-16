// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/IPerpExchange.sol";

/**
 * @title MockPerpExchange
 * @notice Universal test implementation of IPerpExchange.
 *
 * Drop-in replacement for any exchange adapter in tests. Simulates:
 *   - USDC spot wallet deposits / withdrawals
 *   - BTC or ETH spot buy / sell (using Chainlink price for conversions)
 *   - BTC / ETH withdrawal as real ERC-20 or native ETH
 *   - Perp short position open / close with configurable P&L
 *
 * All prices are settable by the test owner. Losses are simulated by
 * directly reducing assetBalance. The mock is intentionally simple —
 * it does NOT simulate funding rates, liquidations, or partial fills.
 *
 * Usage in tests:
 *   1. Deploy MockPerpExchange with USDC + asset addresses.
 *   2. Fund with USDC (for spot buys) and wBTC/ETH (for asset withdrawals).
 *   3. Register as an adapter: kashYield.setPerpExchange("MOCK", mockAddr).
 *   4. Set prices: mock.setAssetPrice(price18dec).
 */
contract MockPerpExchange is IPerpExchange {
    using SafeERC20 for IERC20;

    address public usdcAddress;
    address public assetAddress; // wBTC (8-dec) or address(0) for ETH
    bool    public isEthAsset;

    /// @notice Asset price in USD, 18 decimals (same scale as Chainlink BTC/USD * 1e10).
    uint256 public assetPrice;

    // ── Internal ledgers (per caller address) ────────────────────────────
    mapping(address => uint256) public spotBalances;   // USDC in spot wallet (6-dec)
    mapping(address => uint256) public assetBalances;  // BTC or ETH (18-dec internal)

    struct PerpPosition {
        uint256 size;        // 18-dec
        uint256 collateral;  // 18-dec asset units
        uint256 entryPrice;  // 18-dec USD/asset
        bool    isLong;
        bool    isActive;
    }
    mapping(address => mapping(string => PerpPosition)) public positions;

    address public owner;

    event SpotDeposited(address indexed user, uint256 usdcAmount);
    event SpotWithdrawn(address indexed user, uint256 usdcAmount);
    event SpotTraded(address indexed user, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut);
    event PerpOpened(address indexed user, string symbol, uint256 size, uint256 entryPrice);
    event PerpClosed(address indexed user, string symbol, uint256 size, int256 pnl);
    event AssetWithdrawn(address indexed user, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner");
        _;
    }

    constructor(address _usdcAddress, address _assetAddress, bool _isEthAsset, uint256 _assetPrice) {
        usdcAddress = _usdcAddress;
        assetAddress = _assetAddress;
        isEthAsset = _isEthAsset;
        assetPrice = _assetPrice;
        owner = msg.sender;
    }

    function setAssetPrice(uint256 _price) external onlyOwner {
        assetPrice = _price;
    }

    /// @notice Fund mock with real wBTC so withdrawAsset can transfer it.
    function fundWithAsset(uint256 amount) external {
        require(!isEthAsset, "Use ETH transfer for ETH product");
        IERC20(assetAddress).safeTransferFrom(msg.sender, address(this), amount);
    }

    // ── Capital movement ──────────────────────────────────────────────────

    function depositCollateral(address token, uint256 amount) external override {
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        spotBalances[msg.sender] += amount;
        emit SpotDeposited(msg.sender, amount);
    }

    function withdrawCollateral(address token, uint256 amount) external override returns (uint256 amountTransferred) {
        require(spotBalances[msg.sender] >= amount, "MockPerp: insufficient spot balance");
        spotBalances[msg.sender] -= amount;
        IERC20(token).safeTransfer(msg.sender, amount);
        amountTransferred = amount;
        emit SpotWithdrawn(msg.sender, amountTransferred);
    }

    // ── Spot trading ──────────────────────────────────────────────────────

    function tradeSpot(
        address tokenIn,
        address tokenOut,
        uint256 amountIn
    ) external payable override returns (uint256 amountOut) {
        bool isStableIn = (tokenIn == usdcAddress);

        if (isStableIn) {
            // USDC → asset (spot buy): pull USDC, credit assetBalance
            IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
            // amountIn is USDC (6-dec) → convert to 18-dec → divide by price → 18-dec asset units
            uint256 usdIn18 = amountIn * 1e12;
            amountOut = (usdIn18 * 1e18) / assetPrice;
            assetBalances[msg.sender] += amountOut;
        } else {
            // asset → USDC (spot sell): debit assetBalance, credit spotBalance
            if (tokenIn == address(0)) {
                require(msg.value >= amountIn, "MockPerp: insufficient ETH");
                assetBalances[msg.sender] += msg.value; // credit ETH to ledger first if sent
            }
            require(assetBalances[msg.sender] >= amountIn, "MockPerp: insufficient asset balance");
            assetBalances[msg.sender] -= amountIn;
            // amountIn is 18-dec asset → multiply by price → 18-dec USD → convert to 6-dec USDC
            uint256 usdOut18 = (amountIn * assetPrice) / 1e18;
            amountOut = usdOut18 / 1e12;
            spotBalances[msg.sender] += amountOut;
        }

        emit SpotTraded(msg.sender, tokenIn, tokenOut, amountIn, amountOut);
    }

    function withdrawAsset(uint256 amount) external override {
        require(assetBalances[msg.sender] >= amount, "MockPerp: insufficient asset balance");
        assetBalances[msg.sender] -= amount;

        if (isEthAsset) {
            require(address(this).balance >= amount, "MockPerp: insufficient ETH - fund mock with ETH first");
            (bool ok, ) = payable(msg.sender).call{value: amount}("");
            require(ok, "ETH transfer failed");
        } else {
            uint256 assetAmount8dec = amount / 1e10;
            require(assetAmount8dec > 0, "MockPerp: amount too small");
            require(IERC20(assetAddress).balanceOf(address(this)) >= assetAmount8dec, "MockPerp: insufficient wBTC - call fundWithAsset first");
            IERC20(assetAddress).safeTransfer(msg.sender, assetAmount8dec);
        }

        emit AssetWithdrawn(msg.sender, amount);
    }

    // ── Perp positions ────────────────────────────────────────────────────

    function openPerpPosition(string calldata symbol, uint256 size, bool isLong) external override {
        require(assetPrice > 0, "MockPerp: price not set");
        // Collateral = 10% of position size (mock LTV)
        uint256 collateral = size / 10;
        require(assetBalances[msg.sender] >= collateral, "MockPerp: insufficient asset for collateral");
        assetBalances[msg.sender] -= collateral;

        positions[msg.sender][symbol] = PerpPosition({
            size: size, collateral: collateral, entryPrice: assetPrice, isLong: isLong, isActive: true
        });
        emit PerpOpened(msg.sender, symbol, size, assetPrice);
    }

    function closePerpPosition(string calldata symbol) external override {
        _closePosition(msg.sender, symbol, 0, true);
    }

    function closePerpPosition(string calldata symbol, uint256 closeSize) external override {
        _closePosition(msg.sender, symbol, closeSize, false);
    }

    function _closePosition(address user, string memory symbol, uint256 closeSize, bool fullClose) internal {
        PerpPosition storage pos = positions[user][symbol];
        require(pos.isActive, "MockPerp: no active position");
        require(assetPrice > 0, "MockPerp: price not set");

        uint256 sizeToClose = fullClose ? pos.size : closeSize;
        require(sizeToClose <= pos.size, "MockPerp: closeSize exceeds position");

        int256 priceDiff = int256(assetPrice) - int256(pos.entryPrice);
        int256 direction = pos.isLong ? int256(1) : int256(-1);
        int256 pnlUsd18 = (int256(sizeToClose) * priceDiff * direction) / int256(1e18);

        uint256 collateralToReturn = (pos.collateral * sizeToClose) / pos.size;

        if (fullClose) {
            pos.isActive = false;
            pos.size = 0;
        } else {
            pos.size -= sizeToClose;
            pos.collateral -= collateralToReturn;
            if (pos.size == 0) pos.isActive = false;
        }

        // Return collateral + credit USDC profit (or absorb loss from collateral)
        assetBalances[user] += collateralToReturn;
        if (pnlUsd18 > 0) {
            uint256 profitUsdc = uint256(pnlUsd18) / 1e12;
            spotBalances[user] += profitUsdc;
        }

        emit PerpClosed(user, symbol, sizeToClose, pnlUsd18);
    }

    function cancelOrder(bytes32 /* orderId */) external pure override {}

    // ── Views ─────────────────────────────────────────────────────────────

    function getSpotBalance() external view override returns (uint256) {
        return spotBalances[msg.sender];
    }

    function getAssetBalance() external view override returns (uint256) {
        return assetBalances[msg.sender];
    }

    function getPosition(string calldata symbol) external view override returns (
        uint256 size, uint256 collateral, uint256 entryPrice, bool isLong, bool isActive
    ) {
        PerpPosition memory pos = positions[msg.sender][symbol];
        return (pos.size, pos.collateral, pos.entryPrice, pos.isLong, pos.isActive);
    }

    function getOpenOrderIds() external pure override returns (bytes32[] memory) {
        return new bytes32[](0);
    }

    receive() external payable {}
}
