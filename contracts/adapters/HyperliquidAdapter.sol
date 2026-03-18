// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IPerpExchange.sol";

/// @dev Minimal interface for Hyperliquid (mock or bridge).
interface IHyperliquidCore {
    function depositToSpotWallet(address stableToken, uint256 amount) external;
    function withdrawFromSpotWallet(address stableToken, uint256 amount) external;
    function tradeSpot(address tokenIn, address tokenOut, uint256 amountIn) external payable returns (uint256 amountOut);
    function openPerpPosition(string calldata symbol, uint256 size, bool isLong) external;
    function closePerpPosition(string calldata symbol) external;
    function closePerpPosition(string calldata symbol, uint256 closeSize) external;
    function getSpotBalance(address user) external view returns (uint256);
    function btcBalance(address user) external view returns (uint256);
    function ethBalance(address user) external view returns (uint256);
    function getPosition(address user, string calldata symbol) external view returns (
        uint256 size, uint256 collateral, uint256 entryPrice, bool isLong, bool isActive
    );
    function cancelOrder(bytes32 orderId) external;
    function getOpenOrderIds(address account) external view returns (bytes32[] memory);
    function withdrawBtcFromSpotWallet(uint256 amount) external;
    function withdrawEthFromSpotWallet(uint256 amount) external;
}

/**
 * @title HyperliquidAdapter
 * @notice IPerpExchange adapter for Hyperliquid.
 *
 * Translates standardised KashYield exchange calls into Hyperliquid-specific calls.
 * This adapter IS the Hyperliquid account: all positions and balances are tracked
 * against this contract's address on the Hyperliquid side.
 *
 * TEST ENVIRONMENT: Wraps MockHyperliquid — all calls work synchronously.
 *
 * MAINNET NOTE: Hyperliquid perp trading runs on the HL L1 chain, not Arbitrum.
 * Capital movement (depositCollateral / withdrawCollateral) wraps the HL USDC bridge.
 * Perp operations (openPerpPosition / closePerpPosition) are managed off-chain by the
 * bot via the Hyperliquid REST API; those functions are effectively no-ops in production
 * and the adapter should be replaced with a bridge-only variant for mainnet.
 */
contract HyperliquidAdapter is IPerpExchange {
    using SafeERC20 for IERC20;

    address public hyperliquidAddress;
    address public immutable usdcAddress;
    /// @notice ERC-20 asset address: wBTC (8-dec) for the BTC product, or address(0) for native ETH.
    address public immutable assetAddress;
    /// @notice true if this adapter serves the ETH yield product.
    bool public immutable isEthAsset;

    address public owner;
    address public pendingOwner;

    event AdapterCall(string action, uint256 amount);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner");
        _;
    }

    constructor(
        address _hyperliquidAddress,
        address _usdcAddress,
        address _assetAddress,
        bool _isEthAsset
    ) {
        hyperliquidAddress = _hyperliquidAddress;
        usdcAddress = _usdcAddress;
        assetAddress = _assetAddress;
        isEthAsset = _isEthAsset;
        owner = msg.sender;
    }

    // ── Ownership (two-step) ──────────────────────────────────────────────

    /// @notice Update the MockHyperliquid address without redeploying the adapter.
    function setHyperliquidAddress(address _hyperliquidAddress) external onlyOwner {
        require(_hyperliquidAddress != address(0), "Zero address");
        hyperliquidAddress = _hyperliquidAddress;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "Not pending owner");
        emit OwnershipTransferred(owner, pendingOwner);
        owner = pendingOwner;
        pendingOwner = address(0);
    }

    // ── Capital movement ──────────────────────────────────────────────────

    /// @inheritdoc IPerpExchange
    function depositCollateral(address token, uint256 amount) external override {
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        IERC20(token).forceApprove(hyperliquidAddress, amount);
        IHyperliquidCore(hyperliquidAddress).depositToSpotWallet(token, amount);
        emit AdapterCall("depositCollateral", amount);
    }

    /// @inheritdoc IPerpExchange
    function withdrawCollateral(address token, uint256 amount) external override {
        IHyperliquidCore(hyperliquidAddress).withdrawFromSpotWallet(token, amount);
        IERC20(token).safeTransfer(msg.sender, amount);
        emit AdapterCall("withdrawCollateral", amount);
    }

    // ── Spot trading ──────────────────────────────────────────────────────

    /// @inheritdoc IPerpExchange
    /// @dev For spot buy (USDC → asset): pulls USDC from caller and approves HL.
    ///      For wBTC spot sell: MockHL uses its internal btcBalance[adapter] — no ERC-20 pull.
    ///      For ETH spot sell: native ETH forwarded via msg.value.
    function tradeSpot(
        address tokenIn,
        address tokenOut,
        uint256 amountIn
    ) external payable override returns (uint256 amountOut) {
        if (tokenIn == usdcAddress) {
            // Spot buy: USDC → asset. Pull USDC from caller and forward.
            IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
            IERC20(tokenIn).forceApprove(hyperliquidAddress, amountIn);
            amountOut = IHyperliquidCore(hyperliquidAddress).tradeSpot(tokenIn, tokenOut, amountIn);
        } else if (tokenIn == address(0)) {
            // ETH spot sell: forward native ETH.
            amountOut = IHyperliquidCore(hyperliquidAddress).tradeSpot{value: msg.value}(tokenIn, tokenOut, amountIn);
        } else {
            // wBTC spot sell: MockHL debits btcBalance[adapter] internally — no ERC-20 needed.
            amountOut = IHyperliquidCore(hyperliquidAddress).tradeSpot(tokenIn, tokenOut, amountIn);
        }
        emit AdapterCall("tradeSpot", amountIn);
    }

    /// @inheritdoc IPerpExchange
    function withdrawAsset(uint256 amount) external override {
        if (isEthAsset) {
            IHyperliquidCore(hyperliquidAddress).withdrawEthFromSpotWallet(amount);
            (bool ok, ) = payable(msg.sender).call{value: amount}("");
            require(ok, "ETH transfer failed");
        } else {
            IHyperliquidCore(hyperliquidAddress).withdrawBtcFromSpotWallet(amount);
            uint256 wbtcBal = IERC20(assetAddress).balanceOf(address(this));
            if (wbtcBal > 0) IERC20(assetAddress).safeTransfer(msg.sender, wbtcBal);
        }
        emit AdapterCall("withdrawAsset", amount);
    }

    // ── Perp positions ────────────────────────────────────────────────────

    function openPerpPosition(string calldata symbol, uint256 size, bool isLong) external override {
        IHyperliquidCore(hyperliquidAddress).openPerpPosition(symbol, size, isLong);
    }

    function closePerpPosition(string calldata symbol) external override {
        IHyperliquidCore(hyperliquidAddress).closePerpPosition(symbol);
    }

    function closePerpPosition(string calldata symbol, uint256 closeSize) external override {
        IHyperliquidCore(hyperliquidAddress).closePerpPosition(symbol, closeSize);
    }

    function cancelOrder(bytes32 orderId) external override {
        IHyperliquidCore(hyperliquidAddress).cancelOrder(orderId);
    }

    // ── Views ─────────────────────────────────────────────────────────────

    function getSpotBalance() external view override returns (uint256) {
        return IHyperliquidCore(hyperliquidAddress).getSpotBalance(address(this));
    }

    function getAssetBalance() external view override returns (uint256) {
        if (isEthAsset) {
            return IHyperliquidCore(hyperliquidAddress).ethBalance(address(this));
        } else {
            return IHyperliquidCore(hyperliquidAddress).btcBalance(address(this));
        }
    }

    function getPosition(string calldata symbol) external view override returns (
        uint256 size, uint256 collateral, uint256 entryPrice, bool isLong, bool isActive
    ) {
        return IHyperliquidCore(hyperliquidAddress).getPosition(address(this), symbol);
    }

    function getOpenOrderIds() external view override returns (bytes32[] memory) {
        return IHyperliquidCore(hyperliquidAddress).getOpenOrderIds(address(this));
    }

    receive() external payable {}
}
